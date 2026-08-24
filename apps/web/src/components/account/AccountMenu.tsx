// Who am I, and how do I leave?
//
// Sits next to the organization switcher. The switcher is "which workspace";
// this is "which person". Sign-out is only offered when a real session can
// end — local-owner mode is this machine, so there is nothing to sign out of.
//
// Username is the public alias of the opaque user id: teammates type @jane
// to mention, invite, or send things, rather than a UUID. Display name, bio,
// and photo are the rest of the public profile teammates see in chat.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Input, Textarea } from '@open-design/components';
import {
  BIO_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  isPlaceholderPersonName,
  parseUsername,
  personLabel,
  type UpdateProfileRequest,
} from '@open-design/contracts';
import { useT } from '../../i18n';
import { useAuthActions } from '../../auth/AuthActions';
import { useOptionalOrg } from '../../org/OrgContext';
import { removeAvatar, updateProfile, uploadAvatar } from '../../providers/registry';
import { Icon } from '../Icon';
import { PersonAvatar } from './PersonAvatar';
import styles from './AccountMenu.module.css';

export function AccountMenu() {
  const t = useT();
  const org = useOptionalOrg();
  const { signOut } = useAuthActions();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [usernameDraft, setUsernameDraft] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [bioDraft, setBioDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const photoRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocumentPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDocumentPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocumentPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!org || org.loading) return null;
  const viewer = org.auth?.viewer;
  const refreshOrg = org.refresh;
  if (!viewer) return null;
  const profile = viewer;

  const labeled = personLabel(viewer);
  const seededName = isPlaceholderPersonName(viewer.displayName) ? '' : (viewer.displayName ?? '');
  const canSignOut = typeof signOut === 'function';
  const subtitle = viewer.email?.trim()
    ? viewer.email
    : canSignOut
      ? t('account.signedInAs')
      : t('account.thisComputer');
  const handle = viewer.username ? `@${viewer.username}` : t('account.noUsername');

  function seedDrafts() {
    setUsernameDraft(profile.username ?? '');
    setNameDraft(isPlaceholderPersonName(profile.displayName) ? '' : (profile.displayName ?? ''));
    setBioDraft(profile.bio ?? '');
    setError(null);
    setSaved(false);
  }

  async function handleSignOut() {
    if (!signOut || busy) return;
    setBusy(true);
    try {
      await signOut();
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  async function handleSaveProfile(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const patch: UpdateProfileRequest = {};
    if (usernameDraft.trim()) {
      const parsed = parseUsername(usernameDraft);
      if (!parsed.ok) {
        setSaved(false);
        setError(t('account.usernameInvalid'));
        return;
      }
      if (parsed.username !== (profile.username ?? '')) {
        patch.username = parsed.username;
      }
    }
    if (nameDraft.trim() !== seededName) {
      patch.displayName = nameDraft.trim();
    }
    if ((bioDraft.trim() || '') !== (profile.bio ?? '')) {
      patch.bio = bioDraft.trim();
    }
    if (!patch.username && patch.displayName === undefined && patch.bio === undefined) {
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await updateProfile(patch);
      await refreshOrg();
      setSaved(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(
        /taken|USERNAME_TAKEN/i.test(message)
          ? t('account.usernameTaken')
          : /display name|DISPLAY_NAME|bio|BIO_/i.test(message)
            ? t('account.profileSaveFailed')
            : t('account.usernameSaveFailed'),
      );
    } finally {
      setBusy(false);
    }
  }

  async function handlePhotoChange(file: File | undefined) {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await uploadAvatar(file);
      await refreshOrg();
      setSaved(true);
    } catch {
      setError(t('account.photoFailed'));
    } finally {
      setBusy(false);
      if (photoRef.current) photoRef.current.value = '';
    }
  }

  async function handleRemovePhoto() {
    if (busy || !profile.avatarUrl) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await removeAvatar();
      await refreshOrg();
      setSaved(true);
    } catch {
      setError(t('account.photoFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => {
          setOpen((value) => {
            const next = !value;
            if (next) seedDrafts();
            return next;
          });
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('account.menuAria')}
        data-testid="account-menu-trigger"
      >
        <PersonAvatar name={labeled} avatarUrl={viewer.avatarUrl} className={styles.avatar} />
      </button>

      {open ? (
        <div className={styles.menu} role="menu" data-testid="account-menu">
          <div className={styles.identity}>
            <span className={styles.itemName}>{labeled}</span>
            <span className={styles.itemMeta} data-testid="account-username">
              {handle}
            </span>
            <span className={styles.itemMeta}>{subtitle}</span>
          </div>
          <form className={styles.usernameForm} onSubmit={(event) => void handleSaveProfile(event)}>
            <div className={styles.photoRow}>
              <PersonAvatar name={labeled} avatarUrl={viewer.avatarUrl} className={styles.photoPreview} />
              <div className={styles.photoActions}>
                <input
                  ref={photoRef}
                  id="account-photo-input"
                  className={styles.fileInput}
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  onChange={(event) => void handlePhotoChange(event.target.files?.[0])}
                  data-testid="account-photo-input"
                />
                <Button type="button" variant="ghost" disabled={busy} onClick={() => photoRef.current?.click()}>
                  {t('account.changePhoto')}
                </Button>
                {viewer.avatarUrl ? (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void handleRemovePhoto()}
                    data-testid="account-photo-remove"
                  >
                    {t('account.removePhoto')}
                  </Button>
                ) : null}
              </div>
            </div>
            <label className={styles.usernameLabel} htmlFor="account-display-name-input">
              {t('account.displayName')}
            </label>
            <Input
              id="account-display-name-input"
              value={nameDraft}
              maxLength={DISPLAY_NAME_MAX_LENGTH}
              onChange={(event) => {
                setNameDraft(event.target.value);
                setError(null);
                setSaved(false);
              }}
              placeholder={t('account.displayNamePlaceholder')}
              autoComplete="nickname"
              data-testid="account-display-name-input"
            />
            <label className={styles.usernameLabel} htmlFor="account-bio-input">
              {t('account.bio')}
            </label>
            <Textarea
              id="account-bio-input"
              value={bioDraft}
              maxLength={BIO_MAX_LENGTH}
              rows={3}
              onChange={(event) => {
                setBioDraft(event.target.value);
                setError(null);
                setSaved(false);
              }}
              placeholder={t('account.bioPlaceholder')}
              data-testid="account-bio-input"
            />
            <label className={styles.usernameLabel} htmlFor="account-username-input">
              {viewer.username ? t('account.changeUsername') : t('account.setUsername')}
            </label>
            <Input
              id="account-username-input"
              value={usernameDraft}
              onChange={(event) => {
                setUsernameDraft(event.target.value);
                setError(null);
                setSaved(false);
              }}
              placeholder={t('account.usernamePlaceholder')}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={Boolean(error)}
              data-testid="account-username-input"
            />
            <p className={styles.usernameHint}>{t('account.usernameHint')}</p>
            <Button type="submit" disabled={busy} data-testid="account-username-save">
              {t('account.saveProfile')}
            </Button>
            {error ? (
              <p className={styles.usernameError} data-testid="account-username-error">
                {error}
              </p>
            ) : null}
            {saved ? (
              <p className={styles.usernameSaved} data-testid="account-username-saved">
                {t('account.profileSaved')}
              </p>
            ) : null}
          </form>
          {canSignOut ? (
            <>
              <div className={styles.divider} role="separator" />
              <button
                type="button"
                role="menuitem"
                className={styles.item}
                onClick={() => void handleSignOut()}
                disabled={busy}
                data-testid="account-sign-out"
              >
                <Icon name="log-out" size={14} />
                <span>{t('account.signOut')}</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
