import { memo, useCallback, useId, useState, type FormEvent, type ReactElement } from 'react';
import { submitLogin, type LoginResponse } from './authClient';

export interface AuthUnlockScreenProps {
  readonly isOnline: boolean;
  readonly initialMessage: string | null;
  readonly hasCachedData: boolean;
  readonly onAuthenticated: (session: LoginResponse) => void;
  readonly onContinueOffline: () => void;
}

export const AuthUnlockScreen = memo(function AuthUnlockScreen({
  isOnline,
  initialMessage,
  hasCachedData,
  onAuthenticated,
  onContinueOffline,
}: AuthUnlockScreenProps): ReactElement {
  const secretInputId = useId();
  const errorMessageId = useId();

  const [secret, setSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(initialMessage);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      if (!isOnline || submitting) {
        return;
      }

      if (secret.length === 0) {
        setErrorMessage('Veuillez saisir votre secret personnel.');
        return;
      }

      setSubmitting(true);
      setErrorMessage(null);

      const outcome = await submitLogin({ secret });
      setSubmitting(false);

      if (!outcome.ok) {
        setErrorMessage(outcome.message);
        return;
      }

      setSecret('');
      onAuthenticated(outcome.session);
    },
    [isOnline, submitting, secret, onAuthenticated],
  );

  return (
    <div className="cf-auth-shell">
      <main className="cf-surface cf-auth-card" aria-labelledby="auth-unlock-heading">
        <div style={{ display: 'grid', gap: '6px' }}>
          <h1 id="auth-unlock-heading" style={{ fontSize: '1.5rem' }}>
            ClairFlux
          </h1>
          <p style={{ color: 'var(--text-secondary)' }}>
            Saisissez votre secret personnel pour accéder à vos comptes BoursoBank &amp; Revolut,
            synchroniser Google Drive et consulter l’APK Android.
          </p>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} style={{ display: 'grid', gap: '16px' }} noValidate>
          <div className="cf-field-group">
            <label htmlFor={secretInputId} className="cf-field-label">
              Secret personnel d’accès
            </label>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }}>
              <input
                id={secretInputId}
                type={showSecret ? 'text' : 'password'}
                className={`cf-field-input ${errorMessage ? 'user-invalid-fallback' : ''}`}
                style={{ flex: '1 1 auto', minInlineSize: 0 }}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                required
                autoComplete="current-password"
                autoFocus
                disabled={!isOnline || submitting}
                aria-invalid={errorMessage !== null}
                aria-describedby={errorMessage !== null ? errorMessageId : undefined}
                placeholder="Votre mot de passe personnel"
              />
              <button
                type="button"
                className="cf-btn"
                onClick={() => setShowSecret((prev) => !prev)}
                aria-pressed={showSecret}
                aria-label={showSecret ? 'Masquer le secret' : 'Afficher le secret'}
              >
                {showSecret ? 'Masquer' : 'Afficher'}
              </button>
            </div>
            {errorMessage !== null ? (
              <p
                id={errorMessageId}
                role="alert"
                style={{ color: 'var(--danger)', fontSize: '0.8125rem', fontWeight: 600 }}
              >
                {errorMessage}
              </p>
            ) : null}
          </div>

          <button
            type="submit"
            className="cf-btn cf-btn-primary"
            disabled={!isOnline || submitting}
          >
            {submitting
              ? 'Vérification en cours…'
              : isOnline
                ? 'Déverrouiller ClairFlux'
                : 'Connexion requise pour déverrouiller'}
          </button>
        </form>

        {!isOnline && hasCachedData ? (
          <div
            style={{
              paddingBlockStart: '12px',
              borderBlockStart: '1px solid var(--border-subtle)',
              display: 'grid',
              gap: '8px',
            }}
          >
            <p style={{ color: 'var(--warning)', fontSize: '0.8125rem', fontWeight: 600 }}>
              Mode hors-ligne détecté : vos données synchronisées précédemment sont disponibles en
              consultation locale.
            </p>
            <button type="button" className="cf-btn" onClick={onContinueOffline}>
              Consulter le cache hors-ligne
            </button>
          </div>
        ) : null}
      </main>
    </div>
  );
});
