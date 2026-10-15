import type { useCloud } from './cloud'

type Cloud = ReturnType<typeof useCloud>

/** Sidebar status for the cloud copy of the open show. Sign-in and the show list are on the start page. */
export default function CloudPanel({ cloud, onShows }: { cloud: Cloud; onShows: () => void }) {
  const { configured, user, cloudId, status, error } = cloud

  return (
    <div className="cloud">
      <h2>Cloud</h2>

      {!configured && <p className="hint">Cloud saving isn't set up (missing Firebase settings in client/.env.local).</p>}

      {configured && !user && <p className="hint">Not signed in. Edits are saved in this browser only.</p>}

      {user && (
        <>
          <p className="hint">
            {user.email} ·{' '}
            {cloudId
              ? <>autosaving to the cloud · <b className={status === 'saving' ? '' : 'ok'}>{status === 'saving' ? 'saving…' : 'saved ✓'}</b></>
              : 'this show is not in the cloud yet'}
          </p>
          {/* a show that is already in the cloud autosaves; only one that isn't yet needs this */}
          {!cloudId && <button onClick={cloud.saveNew}>Save to cloud</button>}
        </>
      )}

      <button onClick={onShows}>{user ? 'All shows' : 'Sign in / all shows'}</button>

      {error && <p className="hint bad">{error}</p>}
    </div>
  )
}
