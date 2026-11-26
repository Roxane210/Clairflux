#!/usr/bin/env bash
set -euo pipefail

# Pipeline reproductible de compilation et signature de l'APK Android ClairFlux.
# Utilisable aussi bien dans Dockerfile.apk-builder (/shared-apk) que en CI GitHub Actions (./out-apk).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WEB_DIR="${REPO_ROOT}/apps/web"
ANDROID_DIR="${WEB_DIR}/android"
APK_OUTPUT_DIR="${APK_OUTPUT_DIR:-/shared-apk}"
FINAL_APK_NAME="clairflux-release.apk"
FINAL_APK_PATH="${APK_OUTPUT_DIR}/${FINAL_APK_NAME}"
FINAL_SHA_PATH="${FINAL_APK_PATH}.sha256"

CAPACITOR_CLI_VERSION="${CAPACITOR_CLI_VERSION:-^7.0.0}"
CAPACITOR_CORE_VERSION="${CAPACITOR_CORE_VERSION:-^7.0.0}"
CAPACITOR_ANDROID_VERSION="${CAPACITOR_ANDROID_VERSION:-^7.0.0}"

WORK_TMP_DIR="$(mktemp -d)"
LINKED_CAP_DIR=""
LINKED_CAP_BIN=""

cleanup() {
  if [ -n "${LINKED_CAP_BIN}" ] && [ -L "${LINKED_CAP_BIN}" ]; then
    rm -f "${LINKED_CAP_BIN}"
  fi
  if [ -n "${LINKED_CAP_DIR}" ] && [ -L "${LINKED_CAP_DIR}" ]; then
    rm -f "${LINKED_CAP_DIR}"
  fi
  rm -rf "${WORK_TMP_DIR}"
}
trap cleanup EXIT

log() {
  printf '[build-apk] %s\n' "$*"
}

fail() {
  printf '[build-apk][ERREUR] %s\n' "$*" >&2
  exit 1
}

find_android_tool() {
  local tool_name="$1"
  local sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"

  if [ -n "${sdk_root}" ] && [ -x "${sdk_root}/build-tools/35.0.0/${tool_name}" ]; then
    printf '%s\n' "${sdk_root}/build-tools/35.0.0/${tool_name}"
    return 0
  fi

  if [ -n "${sdk_root}" ] && [ -d "${sdk_root}/build-tools" ]; then
    local candidate
    candidate="$(find "${sdk_root}/build-tools" -maxdepth 2 -type f -name "${tool_name}" 2>/dev/null | sort -V | tail -n 1 || true)"
    if [ -n "${candidate}" ] && [ -x "${candidate}" ]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  fi

  if command -v "${tool_name}" >/dev/null 2>&1; then
    command -v "${tool_name}"
    return 0
  fi

  return 1
}

ensure_capacitor_packages() {
  if node -e "require.resolve('@capacitor/android/package.json', { paths: ['${WEB_DIR}', '${REPO_ROOT}'] }); require.resolve('@capacitor/core/package.json', { paths: ['${WEB_DIR}', '${REPO_ROOT}'] }); require.resolve('@capacitor/cli/package.json', { paths: ['${WEB_DIR}', '${REPO_ROOT}'] });" >/dev/null 2>&1; then
    log "Dépendances Capacitor déjà résolubles depuis le workspace."
    return 0
  fi

  local cap_source=""
  if [ -d "/opt/capacitor/node_modules/@capacitor/android" ] && [ -d "/opt/capacitor/node_modules/@capacitor/core" ] && [ -d "/opt/capacitor/node_modules/@capacitor/cli" ]; then
    log "Utilisation des paquets Capacitor pré-installés (/opt/capacitor)."
    cap_source="/opt/capacitor/node_modules"
  else
    log "Installation éphémère de @capacitor/cli, @capacitor/core et @capacitor/android dans un répertoire temporaire..."
    mkdir -p "${WORK_TMP_DIR}/capacitor"
    npm install \
      --prefix "${WORK_TMP_DIR}/capacitor" \
      --no-save \
      --no-package-lock \
      --no-audit \
      --no-fund \
      "@capacitor/cli@${CAPACITOR_CLI_VERSION}" \
      "@capacitor/core@${CAPACITOR_CORE_VERSION}" \
      "@capacitor/android@${CAPACITOR_ANDROID_VERSION}"
    cap_source="${WORK_TMP_DIR}/capacitor/node_modules"
  fi

  mkdir -p "${WEB_DIR}/node_modules/.bin"
  if [ ! -e "${WEB_DIR}/node_modules/@capacitor" ]; then
    ln -s "${cap_source}/@capacitor" "${WEB_DIR}/node_modules/@capacitor"
    if [[ "${cap_source}" == "${WORK_TMP_DIR}"* ]]; then
      LINKED_CAP_DIR="${WEB_DIR}/node_modules/@capacitor"
    fi
  fi
  if [ ! -e "${WEB_DIR}/node_modules/.bin/cap" ] && [ -e "${cap_source}/.bin/cap" ]; then
    ln -s "${cap_source}/.bin/cap" "${WEB_DIR}/node_modules/.bin/cap"
    if [[ "${cap_source}" == "${WORK_TMP_DIR}"* ]]; then
      LINKED_CAP_BIN="${WEB_DIR}/node_modules/.bin/cap"
    fi
  fi
}

patch_android_pixel8_manifest_and_styles() {
  local manifest_path="${ANDROID_DIR}/app/src/main/AndroidManifest.xml"
  local styles_path="${ANDROID_DIR}/app/src/main/res/values/styles.xml"

  if [ ! -f "${manifest_path}" ]; then
    fail "AndroidManifest.xml introuvable : ${manifest_path}"
  fi

  log "Application idempotente du profil Google Pixel 8 / Android 15 SDK 35 (Manifest + styles.xml)..."
  node - "${manifest_path}" "${styles_path}" <<'NODE_EOF'
const fs = require('node:fs');
const path = require('node:path');

const [manifestPath, stylesPath] = process.argv.slice(2);
const expectedConfigChanges =
  'orientation|keyboardHidden|keyboard|screenSize|smallestScreenSize|locale|layoutDirection|fontScale|screenLayout|density|uiMode';

let manifest = fs.readFileSync(manifestPath, 'utf8');
const activityMatch = /<activity\b[\s\S]*?>/.exec(manifest);
if (!activityMatch) {
  throw new Error(`Balise <activity> introuvable dans ${manifestPath}`);
}

let activityTag = activityMatch[0];
const upsertActivityAttr = (tag, attrName, attrValue) => {
  const attrRegex = new RegExp(`\\b${attrName}\\s*=\\s*"[^"]*"`);
  if (attrRegex.test(tag)) {
    return tag.replace(attrRegex, `${attrName}="${attrValue}"`);
  }
  if (tag.endsWith('/>')) {
    return `${tag.slice(0, -2)} ${attrName}="${attrValue}" />`;
  }
  return `${tag.slice(0, -1)} ${attrName}="${attrValue}">`;
};

activityTag = upsertActivityAttr(activityTag, 'android:screenOrientation', 'fullUser');
activityTag = upsertActivityAttr(activityTag, 'android:configChanges', expectedConfigChanges);
activityTag = upsertActivityAttr(activityTag, 'android:windowSoftInputMode', 'adjustResize');
manifest =
  manifest.slice(0, activityMatch.index) +
  activityTag +
  manifest.slice(activityMatch.index + activityMatch[0].length);
fs.writeFileSync(manifestPath, manifest, 'utf8');

const styleItems = [
  ['android:windowLayoutInDisplayCutoutMode', 'shortEdges'],
  ['android:windowLightStatusBar', 'true'],
  ['android:windowLightNavigationBar', 'true'],
];

if (!fs.existsSync(stylesPath)) {
  fs.mkdirSync(path.dirname(stylesPath), { recursive: true });
  const initialXml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<resources>',
    '    <style name="AppTheme.NoActionBar" parent="Theme.AppCompat.DayNight.NoActionBar">',
    ...styleItems.map(([name, val]) => `        <item name="${name}">${val}</item>`),
    '    </style>',
    '</resources>',
    '',
  ].join('\n');
  fs.writeFileSync(stylesPath, initialXml, 'utf8');
} else {
  let styles = fs.readFileSync(stylesPath, 'utf8');
  const styleBlockRegex =
    /(<style\b[^>]*name="(?:AppTheme\.NoActionBar|AppTheme)"[^>]*>)([\s\S]*?)(<\/style>)/;
  const styleMatch = styleBlockRegex.exec(styles);
  if (!styleMatch) {
    const fallbackClosingIdx = styles.lastIndexOf('</resources>');
    if (fallbackClosingIdx === -1) {
      throw new Error(`Balise </resources> introuvable dans ${stylesPath}`);
    }
    const injectedStyle = [
      '    <style name="AppTheme.NoActionBar" parent="Theme.AppCompat.DayNight.NoActionBar">',
      ...styleItems.map(([name, val]) => `        <item name="${name}">${val}</item>`),
      '    </style>',
      '',
    ].join('\n');
    styles = styles.slice(0, fallbackClosingIdx) + injectedStyle + styles.slice(fallbackClosingIdx);
  } else {
    let body = styleMatch[2];
    for (const [name, val] of styleItems) {
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const itemRegex = new RegExp(`<item\\s+name="${escapedName}"\\s*>[\\s\\S]*?<\\/item>`);
      const replacement = `<item name="${name}">${val}</item>`;
      if (itemRegex.test(body)) {
        body = body.replace(itemRegex, replacement);
      } else {
        const trimmedEnd = body.replace(/\s*$/, '');
        body = `${trimmedEnd}\n        ${replacement}\n    `;
      }
    }
    styles =
      styles.slice(0, styleMatch.index) +
      styleMatch[1] +
      body +
      styleMatch[3] +
      styles.slice(styleMatch.index + styleMatch[0].length);
  }
  fs.writeFileSync(stylesPath, styles, 'utf8');
}
NODE_EOF
}

# ------------------------------------------------------------------------------
# Étape 1 : Build du bundle web (@clairflux/web)
# ------------------------------------------------------------------------------
log "Étape 1/4 : Build frontend @clairflux/web..."
cd "${REPO_ROOT}"
npm run build --workspace=@clairflux/web

if [ ! -f "${WEB_DIR}/dist/index.html" ]; then
  fail "Le build web n'a pas produit ${WEB_DIR}/dist/index.html."
fi

# ------------------------------------------------------------------------------
# Étape 2 : Préparation & synchronisation Capacitor Android
# ------------------------------------------------------------------------------
log "Étape 2/4 : Préparation et synchronisation Capacitor Android..."
ensure_capacitor_packages

cd "${WEB_DIR}"
if [ ! -d "${ANDROID_DIR}" ]; then
  log "Répertoire android/ absent : exécution de npx cap add android..."
  npx --no-install cap add android
fi

log "Exécution de npx cap sync android..."
npx --no-install cap sync android

patch_android_pixel8_manifest_and_styles

if [ ! -x "${ANDROID_DIR}/gradlew" ] && [ ! -f "${ANDROID_DIR}/gradlew" ]; then
  fail "Wrapper Gradle introuvable dans ${ANDROID_DIR}/gradlew après cap sync."
fi

# ------------------------------------------------------------------------------
# Étape 3 : Compilation Gradle (assembleRelease) & signature APK
# ------------------------------------------------------------------------------
log "Étape 3/4 : Compilation Gradle assembleRelease..."
cd "${ANDROID_DIR}"
chmod +x ./gradlew
./gradlew assembleRelease --no-daemon

RAW_APK=""
for candidate in \
  "${ANDROID_DIR}/app/build/outputs/apk/release/app-release-unsigned.apk" \
  "${ANDROID_DIR}/app/build/outputs/apk/release/app-release.apk"; do
  if [ -f "${candidate}" ]; then
    RAW_APK="${candidate}"
    break
  fi
done

if [ -z "${RAW_APK}" ]; then
  fail "Aucun APK release généré sous ${ANDROID_DIR}/app/build/outputs/apk/release/."
fi

log "APK Gradle généré : ${RAW_APK}"

ZIPALIGN_BIN="$(find_android_tool zipalign || true)"
APKSIGNER_BIN="$(find_android_tool apksigner || true)"
BUILT_FINAL_APK="${WORK_TMP_DIR}/${FINAL_APK_NAME}"

if [ -n "${ANDROID_KEYSTORE_PATH:-}" ]; then
  log "Signature release avec keystore fourni (${ANDROID_KEYSTORE_PATH})..."
  [ -f "${ANDROID_KEYSTORE_PATH}" ] || fail "ANDROID_KEYSTORE_PATH introuvable : ${ANDROID_KEYSTORE_PATH}"
  [ -n "${ANDROID_KEYSTORE_PASSWORD:-}" ] || fail "ANDROID_KEYSTORE_PASSWORD est requis lorsque ANDROID_KEYSTORE_PATH est défini."
  [ -n "${ANDROID_KEY_ALIAS:-}" ] || fail "ANDROID_KEY_ALIAS est requis lorsque ANDROID_KEYSTORE_PATH est défini."
  [ -n "${ZIPALIGN_BIN}" ] || fail "zipalign est requis pour aligner l'APK signé."
  [ -n "${APKSIGNER_BIN}" ] || fail "apksigner est requis pour signer l'APK release."

  EFFECTIVE_KEY_PASSWORD="${ANDROID_KEY_PASSWORD:-${ANDROID_KEYSTORE_PASSWORD}}"

  "${ZIPALIGN_BIN}" -p -f 4 "${RAW_APK}" "${WORK_TMP_DIR}/aligned.apk"
  export CLAIRFLUX_KS_PASS="${ANDROID_KEYSTORE_PASSWORD}"
  export CLAIRFLUX_KEY_PASS="${EFFECTIVE_KEY_PASSWORD}"
  "${APKSIGNER_BIN}" sign \
    --ks "${ANDROID_KEYSTORE_PATH}" \
    --ks-pass "env:CLAIRFLUX_KS_PASS" \
    --ks-key-alias "${ANDROID_KEY_ALIAS}" \
    --key-pass "env:CLAIRFLUX_KEY_PASS" \
    --out "${BUILT_FINAL_APK}" \
    "${WORK_TMP_DIR}/aligned.apk"
  unset CLAIRFLUX_KS_PASS CLAIRFLUX_KEY_PASS

  "${APKSIGNER_BIN}" verify "${BUILT_FINAL_APK}"
elif [ -n "${ZIPALIGN_BIN}" ] && [ -n "${APKSIGNER_BIN}" ] && command -v keytool >/dev/null 2>&1; then
  log "Aucun keystore release fourni : génération d'un keystore debug éphémère pour signature dev propre..."
  DEV_KEYSTORE="${WORK_TMP_DIR}/dev-debug.keystore"
  keytool -genkeypair \
    -v \
    -keystore "${DEV_KEYSTORE}" \
    -storepass "android" \
    -alias "androiddebugkey" \
    -keypass "android" \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -dname "CN=ClairFlux Dev,O=ClairFlux,C=FR" >/dev/null 2>&1

  "${ZIPALIGN_BIN}" -p -f 4 "${RAW_APK}" "${WORK_TMP_DIR}/aligned.apk"
  "${APKSIGNER_BIN}" sign \
    --ks "${DEV_KEYSTORE}" \
    --ks-pass "pass:android" \
    --ks-key-alias "androiddebugkey" \
    --key-pass "pass:android" \
    --out "${BUILT_FINAL_APK}" \
    "${WORK_TMP_DIR}/aligned.apk"

  "${APKSIGNER_BIN}" verify "${BUILT_FINAL_APK}"
elif [ -n "${ZIPALIGN_BIN}" ]; then
  log "apksigner absent : alignement zipalign de l'APK release sans signature."
  "${ZIPALIGN_BIN}" -p -f 4 "${RAW_APK}" "${BUILT_FINAL_APK}"
else
  log "zipalign/apksigner absents : copie de l'APK release tel quel."
  cp "${RAW_APK}" "${BUILT_FINAL_APK}"
fi

# ------------------------------------------------------------------------------
# Étape 4 : Copie vers APK_OUTPUT_DIR & génération de l'empreinte SHA-256
# ------------------------------------------------------------------------------
log "Étape 4/4 : Publication vers ${APK_OUTPUT_DIR}..."
mkdir -p "${APK_OUTPUT_DIR}"
cp "${BUILT_FINAL_APK}" "${FINAL_APK_PATH}"
chmod 644 "${FINAL_APK_PATH}"

(
  cd "${APK_OUTPUT_DIR}"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${FINAL_APK_NAME}" > "${FINAL_APK_NAME}.sha256"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${FINAL_APK_NAME}" > "${FINAL_APK_NAME}.sha256"
  else
    fail "Aucun utilitaire sha256sum ou shasum disponible."
  fi
)
chmod 644 "${FINAL_SHA_PATH}"

log "APK publié : ${FINAL_APK_PATH}"
log "Empreinte SHA-256 : $(cat "${FINAL_SHA_PATH}")"
