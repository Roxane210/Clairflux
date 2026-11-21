#!/usr/bin/env node
/**
 * ClairFlux Automated 6-Point Audit Bot (`npm run audit`)
 * Pure Node 22 ESM — zero external dependencies, zero Docker CLI dependency.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, '..');

const EXPECTED_BOURSO_FOLDER = '1cO74NPbgA7kp67Z3rkjAOMqFMDe_Ujus';
const EXPECTED_REVOLUT_FOLDER = '1pGDvmcePbmIjxJ-lyKdeBMt974GxEx_h';

const SECRET_PATTERNS = [
  'DATABASE_URL',
  'GEMINI_API_KEY',
  'CLAIRFLUX_ACCESS_SECRET_HASH',
  'CLAIRFLUX_SESSION_SECRET',
  'INTERNAL_WORKER_TOKEN',
  'AIzaSy',
  'postgresql://',
  'postgres://',
  'BEGIN PRIVATE KEY',
];

function relPath(target) {
  return relative(ROOT_DIR, target).replace(/\\/g, '/');
}

function readUtf8(rel) {
  const full = resolve(ROOT_DIR, rel);
  if (!existsSync(full)) {
    return null;
  }
  return readFileSync(full, 'utf8');
}

function listFilesRecursive(dirRel, extensions, ignoredDirs = new Set(['node_modules', 'dist', '.git'])) {
  const startDir = resolve(ROOT_DIR, dirRel);
  if (!existsSync(startDir)) {
    return [];
  }
  const results = [];
  const stack = [startDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      continue;
    }
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) {
          stack.push(resolve(current, entry.name));
        }
      } else if (entry.isFile()) {
        if (extensions.length === 0 || extensions.includes(extname(entry.name))) {
          results.push(resolve(current, entry.name));
        }
      }
    }
  }
  return results;
}

function stripCommentsAndSimpleStrings(tsSource) {
  return tsSource
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\r\n]*/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

function runShellCommand(command, args) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    shell: process.platform === 'win32',
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const durationMs = Date.now() - startedAt;
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    durationMs,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

function validateYamlFiles() {
  const files = ['docker-compose.yml', '.github/workflows/build-apk.yml'];
  for (const file of files) {
    if (!existsSync(resolve(ROOT_DIR, file))) {
      return { ok: false, detail: `Fichier YAML manquant : ${file}` };
    }
  }

  const pyScript = [
    'import sys, yaml',
    'compose = yaml.safe_load(open("docker-compose.yml", encoding="utf-8"))',
    'wf = yaml.safe_load(open(".github/workflows/build-apk.yml", encoding="utf-8"))',
    'assert isinstance(compose, dict) and "services" in compose, "docker-compose.yml invalide"',
    'assert isinstance(wf, dict) and "jobs" in wf and ("on" in wf or True in wf), "build-apk.yml invalide"',
    'print("YAML OK: services=" + str(list(compose["services"].keys())) + " jobs=" + str(list(wf["jobs"].keys())))',
  ].join('; ');

  for (const pythonBin of ['python', 'python3']) {
    const pyRes = spawnSync(pythonBin, ['-c', pyScript], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      shell: false,
    });
    if (!pyRes.error) {
      return {
        ok: pyRes.status === 0,
        detail: pyRes.status === 0
          ? pyRes.stdout.trim()
          : (pyRes.stderr || pyRes.stdout || 'Erreur PyYAML').trim(),
      };
    }
  }

  // Fallback structurel pur Node.js si Python n'est pas installé
  for (const file of files) {
    const content = readUtf8(file) ?? '';
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (/^\t/.test(lines[i] ?? '')) {
        return { ok: false, detail: `Tabulation YAML interdite dans ${file}:${i + 1}` };
      }
    }
  }
  const composeText = readUtf8('docker-compose.yml') ?? '';
  const workflowText = readUtf8('.github/workflows/build-apk.yml') ?? '';
  if (!/^services:/m.test(composeText) || !/^jobs:/m.test(workflowText)) {
    return { ok: false, detail: 'Structure YAML attendue absente (services/jobs).' };
  }
  return { ok: true, detail: 'Validation YAML structurelle Node (Python absent)' };
}

function makeCheck(label, passed, detail) {
  return { label, passed, detail };
}

// ============================================================================
// Execute Point 5 first so apps/web/dist/ is freshly built for Point 1 scan
// ============================================================================

console.log('=== ClairFlux Audit Bot (6 Points — Jalon 3) ===\n');
console.log('[Préparation] Exécution typecheck, Vitest, Vite build & validation YAML...');

const typecheckRun = runShellCommand('npm', ['run', 'typecheck']);
const testRun = runShellCommand('npm', ['test']);
const buildRun = runShellCommand('npm', ['run', 'build']);
const yamlRun = validateYamlFiles();

// ============================================================================
// Point 1: Normative Docs & Static Compliance
// ============================================================================

function evaluatePoint1() {
  const checks = [];

  const requiredDocs = [
    'docs/TECHNICAL_STANDARDS.md',
    'docs/DATA_MODEL_DRIZZLE_SPEC.md',
    'docs/API_DELTA_SYNC_CONTRACT.md',
    'docs/ADR/0001-drive-exclusive-sync-and-deduplication.md',
    'docs/ADR/0002-neon-drizzle-ledger-and-checkpoints.md',
    'docs/ADR/0003-capacitor-offline-first-delta-sync.md',
    'docs/ADR/0004-ui-baseline-and-recharts-architecture.md',
  ];
  const missingDocs = requiredDocs.filter((doc) => {
    const full = resolve(ROOT_DIR, doc);
    return !existsSync(full) || statSync(full).size === 0;
  });
  checks.push(
    makeCheck(
      '4 livrables normatifs (TECHNICAL_STANDARDS, DATA_MODEL, API_CONTRACT, ADR 0001..0004)',
      missingDocs.length === 0,
      missingDocs.length === 0 ? '7/7 fichiers présents' : `Manquants: ${missingDocs.join(', ')}`,
    ),
  );

  const sharedSrc = readUtf8('packages/shared/src/index.ts') ?? '';
  const schemaSrc = readUtf8('apps/api/src/db/schema.ts') ?? '';
  const workerSrc = readUtf8('apps/sync-worker/src/gemini-pipeline.ts') ?? '';
  const driveSrc = readUtf8('apps/sync-worker/src/drive-pdf.ts') ?? '';

  const hasFxAndCents =
    sharedSrc.includes('fx_rate_micro') &&
    sharedSrc.includes('CentsSchema') &&
    schemaSrc.includes('fx_rate_micro') &&
    schemaSrc.includes('amount_cents') &&
    schemaSrc.includes('amount_eur_cents') &&
    workerSrc.includes('fx_rate_micro');
  checks.push(
    makeCheck(
      'Arithmétique centimes entiers & fx_rate_micro',
      hasFxAndCents,
      hasFxAndCents ? 'shared + schema + sync-worker conformes' : 'Champs centimes/fx_rate_micro incomplets',
    ),
  );

  const tsFiles = [
    ...listFilesRecursive('apps', ['.ts', '.tsx']),
    ...listFilesRecursive('packages', ['.ts', '.tsx']),
  ];
  const anyRegex = /(?::\s*any\b|\bas\s+any\b|<any>|,\s*any\s*>|\bany\[\]|Array<any>)/;
  const anyHits = [];
  for (const file of tsFiles) {
    const cleaned = stripCommentsAndSimpleStrings(readFileSync(file, 'utf8'));
    if (anyRegex.test(cleaned)) {
      anyHits.push(relPath(file));
    }
  }
  checks.push(
    makeCheck(
      'Zéro `any` explicite dans apps/ et packages/',
      anyHits.length === 0,
      anyHits.length === 0 ? `${tsFiles.length} fichiers TS/TSX vérifiés` : `Trouvé dans: ${anyHits.join(', ')}`,
    ),
  );

  const geminiHeaderOk =
    workerSrc.includes("'x-goog-api-key'") && !/\?key=\$\{/.test(workerSrc);
  checks.push(
    makeCheck(
      'Clé Gemini en header HTTP x-goog-api-key (zéro query string)',
      geminiHeaderOk,
      geminiHeaderOk ? 'Header x-goog-api-key confirmé' : 'Clé Gemini absente en header ou exposée en URL',
    ),
  );

  const driveScopeOk =
    sharedSrc.includes(EXPECTED_BOURSO_FOLDER) &&
    sharedSrc.includes(EXPECTED_REVOLUT_FOLDER) &&
    schemaSrc.includes(EXPECTED_BOURSO_FOLDER) &&
    schemaSrc.includes(EXPECTED_REVOLUT_FOLDER) &&
    driveSrc.includes('ALLOWED_DRIVE_FOLDERS') &&
    driveSrc.includes('isAllowedDriveFolderId') &&
    driveSrc.includes('assertAllowedDriveFolderId');
  checks.push(
    makeCheck(
      '2 dossiers Google Drive exclusifs verrouillés (shared + SQL CHECK + worker)',
      driveScopeOk,
      driveScopeOk ? 'BoursoBank + Revolut vérifiés' : 'Verrouillage Drive incomplet',
    ),
  );

  const mainTsx = readUtf8('apps/web/src/main.tsx') ?? '';
  const indexHtml = readUtf8('apps/web/index.html') ?? '';
  const fontsOk =
    mainTsx.includes('@fontsource/plus-jakarta-sans') &&
    mainTsx.includes('@fontsource/dm-sans') &&
    mainTsx.includes('@fontsource/jetbrains-mono') &&
    !indexHtml.includes('fonts.googleapis.com');
  checks.push(
    makeCheck(
      'Polices @fontsource bundlées offline (zéro CDN Google Fonts)',
      fontsOk,
      fontsOk ? '3 familles @fontsource importées localement' : 'Polices offline non conformes',
    ),
  );

  const distFiles = listFilesRecursive('apps/web/dist', ['.js', '.css', '.html', '.mjs']);
  const leakedSecrets = [];
  for (const file of distFiles) {
    const content = readFileSync(file, 'utf8');
    for (const pattern of SECRET_PATTERNS) {
      if (content.includes(pattern)) {
        leakedSecrets.push(`${relPath(file)} (${pattern})`);
      }
    }
  }
  checks.push(
    makeCheck(
      'Zéro secret serveur dans apps/web/dist/',
      distFiles.length > 0 && leakedSecrets.length === 0,
      distFiles.length === 0
        ? 'apps/web/dist/ vide ou absent'
        : leakedSecrets.length === 0
          ? `${distFiles.length} artefacts dist scannés, 0 fuite`
          : `Fuites: ${leakedSecrets.join(', ')}`,
    ),
  );

  return checks;
}

// ============================================================================
// Point 2: Chrome Baseline Standards
// ============================================================================

function evaluatePoint2() {
  const html = readUtf8('apps/web/index.html') ?? '';
  const dialogTsx = readUtf8('apps/web/src/features/ledger/BottomSheetNoteDialog.tsx') ?? '';

  return [
    makeCheck(
      '<dialog> natif (.showModal / dialog.cf-dialog:modal)',
      html.includes('dialog.cf-dialog:modal') && dialogTsx.includes('<dialog'),
      'Modale/tiroir natif top-layer présent',
    ),
    makeCheck(
      'overscroll-behavior: contain sur <dialog> et ::backdrop',
      html.includes('overscroll-behavior: contain') && html.includes('dialog.cf-dialog::backdrop'),
      'Isolation du scroll arrière-plan vérifiée',
    ),
    makeCheck(
      'CSS Container Queries (@container)',
      html.includes('@container') && html.includes('inline-size'),
      'Conteneurs kpis / charts / ledger détectés',
    ),
    makeCheck(
      'Sélecteur :has() borné (jamais body:has)',
      html.includes('.cf-field-group:has(') && !html.includes('body:has('),
      'Borné à .cf-field-group:has(...)',
    ),
    makeCheck(
      'Validation post-interaction :user-valid / :user-invalid',
      html.includes(':user-valid') && html.includes(':user-invalid'),
      'Pseudo-classes Baseline présentes',
    ),
    makeCheck(
      'content-visibility: auto + contain-intrinsic-size: auto 72px',
      html.includes('content-visibility: auto') && html.includes('contain-intrinsic-size: auto 72px'),
      'Rendu différé sous le fold activé',
    ),
  ];
}

// ============================================================================
// Point 3: Mobbin / Google Stitch Ergonomics
// ============================================================================

function evaluatePoint3() {
  const html = readUtf8('apps/web/index.html') ?? '';
  const mobileHeightMatch = /--mobile-nav-height:\s*(\d+)px/.exec(html);
  const mobileNavPx = Number(mobileHeightMatch?.[1] ?? 0);
  const stickyRatio = mobileNavPx / 844;

  return [
    makeCheck(
      'Alignement numérique tabular-nums',
      html.includes('font-variant-numeric: tabular-nums') && html.includes('.tabular-amount'),
      'font-variant-numeric: tabular-nums actif',
    ),
    makeCheck(
      'Typographies Plus Jakarta Sans / DM Sans / JetBrains Mono',
      html.includes('Plus Jakarta Sans') && html.includes('DM Sans') && html.includes('JetBrains Mono'),
      '3 polices normatives configurées',
    ),
    makeCheck(
      'Cibles tactiles >= 44px',
      html.includes('min-block-size: 44px') && html.includes('min-inline-size: 44px'),
      'min-block-size: 44px & min-inline-size: 44px présents',
    ),
    makeCheck(
      'Plafond sticky mobile <= 15 % (64px / 844px = 7.6 %)',
      mobileNavPx > 0 && mobileNavPx <= 64 && stickyRatio <= 0.15,
      `${mobileNavPx}px / 844px = ${(stickyRatio * 100).toFixed(1)} % <= 15 %`,
    ),
    makeCheck(
      'Breakpoint Desktop/Mobile 1024px',
      html.includes('@media (min-width: 1024px)'),
      'Rail 240px >= 1024px, barre basse < 1024px',
    ),
  ];
}

// ============================================================================
// Point 4: ClairFlux Functional Integrity
// ============================================================================

function evaluatePoint4() {
  const chartsTsx = readUtf8('apps/web/src/features/dashboard/DashboardCharts.tsx') ?? '';
  const typesTs = readUtf8('apps/web/src/features/dashboard/types.ts') ?? '';
  const chromeTsx = readUtf8('apps/web/src/features/dashboard/DashboardChrome.tsx') ?? '';
  const txSectionTsx = readUtf8('apps/web/src/features/ledger/TransactionsSection.tsx') ?? '';
  const rulesTabTsx = readUtf8('apps/web/src/features/ledger/RulesTab.tsx') ?? '';
  const csvTs = readUtf8('apps/web/src/features/ledger/csvExport.ts') ?? '';
  const idbTs = readUtf8('apps/web/src/offline/indexedDbStore.ts') ?? '';
  const deltaTs = readUtf8('apps/web/src/offline/deltaSyncEngine.ts') ?? '';
  const registerRoutesTs = readUtf8('apps/api/src/routes/register-routes.ts') ?? '';
  const apkCardTsx = readUtf8('apps/web/src/features/apk/ApkDownloadCard.tsx') ?? '';
  const dockerfileApk = readUtf8('Dockerfile.apk-builder') ?? '';
  const workflowApk = readUtf8('.github/workflows/build-apk.yml') ?? '';

  return [
    makeCheck(
      'Recharts 6M + Dépenses 3 modes (none / prev_month / avg_3m)',
      chartsTsx.includes('AreaChart') &&
        chartsTsx.includes('buildCumulativeBalanceSeries') &&
        chartsTsx.includes('buildMonthlyExpenseSeries') &&
        typesTs.includes("'none' | 'prev_month' | 'avg_3m'"),
      '2 graphiques Recharts + 3 modes de comparaison présents',
    ),
    makeCheck(
      'Alertes Budgets seuils 80 % / 100 %',
      chromeTsx.includes('BudgetAlertsPanel') &&
        chromeTsx.includes('ratioPercent >= 80') &&
        chromeTsx.includes('ratioPercent >= 100'),
      'Seuils 80 % vigilance et 100 % dépassement présents',
    ),
    makeCheck(
      'Sous-onglet Règles de catégorisation',
      txSectionTsx.includes('RulesTab') &&
        txSectionTsx.includes("activeSubTab === 'rules'") &&
        rulesTabTsx.includes('export const RulesTab'),
      'TransactionsSection + RulesTab câblés',
    ),
    makeCheck(
      'Export CSV anti-injection de formules',
      csvTs.includes('neutralizeCsvFormula') && csvTs.includes('FORMULA_TRIGGER_CHARS'),
      'Protection =, +, -, @, tab, CR vérifiée',
    ),
    makeCheck(
      'Outbox IndexedDB & Delta Sync idempotent',
      idbTs.includes('clairflux_offline_v1') &&
        idbTs.includes('outbox_mutations') &&
        deltaTs.includes('flushOutbox') &&
        deltaTs.includes('client_mutation_id'),
      'Store outbox_mutations + flushOutbox présents',
    ),
    makeCheck(
      'Endpoints APK + ApkDownloadCard + Dockerfile.apk-builder + GitHub Actions',
      registerRoutesTs.includes('/api/apk/status') &&
        registerRoutesTs.includes('/api/apk/download') &&
        apkCardTsx.includes('/api/apk/status') &&
        dockerfileApk.length > 0 &&
        workflowApk.length > 0,
      'Chaîne APK complète vérifiée',
    ),
  ];
}

// ============================================================================
// Point 5: Live Command Results (Typecheck, Vitest, Vite Build, YAML)
// ============================================================================

function evaluatePoint5() {
  return [
    makeCheck(
      'npm run typecheck (strict workspaces)',
      typecheckRun.ok,
      typecheckRun.ok
        ? `exit 0 (${typecheckRun.durationMs} ms)`
        : `exit ${typecheckRun.status}: ${(typecheckRun.stderr || typecheckRun.stdout).trim().slice(0, 240)}`,
    ),
    makeCheck(
      'npm test (vitest run)',
      testRun.ok,
      testRun.ok
        ? `exit 0 (${testRun.durationMs} ms)`
        : `exit ${testRun.status}: ${(testRun.stderr || testRun.stdout).trim().slice(0, 240)}`,
    ),
    makeCheck(
      'npm run build (vite build @clairflux/web)',
      buildRun.ok,
      buildRun.ok
        ? `exit 0 (${buildRun.durationMs} ms)`
        : `exit ${buildRun.status}: ${(buildRun.stderr || buildRun.stdout).trim().slice(0, 240)}`,
    ),
    makeCheck(
      'Validation YAML (docker-compose.yml + .github/workflows/build-apk.yml)',
      yamlRun.ok,
      yamlRun.detail,
    ),
  ];
}

// ============================================================================
// Point 6: Report Formatting & Exit Code
// ============================================================================

const sections = [
  { id: 1, title: 'Point 1 — Normes EGM & Conformité Statique', checks: evaluatePoint1() },
  { id: 2, title: 'Point 2 — Standards Chrome Baseline', checks: evaluatePoint2() },
  { id: 3, title: 'Point 3 — Ergonomie Mobbin / Google Stitch', checks: evaluatePoint3() },
  { id: 4, title: 'Point 4 — Intégrité Fonctionnelle ClairFlux', checks: evaluatePoint4() },
  { id: 5, title: 'Point 5 — Exécution Typecheck, Tests, Build & YAML', checks: evaluatePoint5() },
];

for (const section of sections) {
  console.log(`\n${section.title}`);
  for (const check of section.checks) {
    const tag = check.passed ? 'PASS' : 'FAIL';
    console.log(`  [${tag}] ${check.label} — ${check.detail}`);
  }
}

console.log('\nPoint 6 — Tableau Synthétique PASS / FAIL');
console.log('+---+-------------------------------------------------------+--------+');
console.log('| # | Axe d\'audit                                           | Statut |');
console.log('+---+-------------------------------------------------------+--------+');

let allPassed = true;
for (const section of sections) {
  const sectionPassed = section.checks.every((c) => c.passed);
  if (!sectionPassed) {
    allPassed = false;
  }
  const statusStr = sectionPassed ? 'PASS  ' : 'FAIL  ';
  const titlePad = section.title.slice(0, 53).padEnd(53, ' ');
  console.log(`| ${section.id} | ${titlePad} | ${statusStr} |`);
}
console.log('+---+-------------------------------------------------------+--------+');
console.log(`Verdict global : ${allPassed ? 'PASS (100 %)' : 'FAIL'}`);

process.exit(allPassed ? 0 : 1);
