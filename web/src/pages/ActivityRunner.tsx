import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useActivityGate } from '../lib/activityGate';
import { Alert, Badge, PageLoader } from '../components/ui';
import { BlocksRenderer } from '../renderers/BlockRenderer';
import type { ActivityDetail, ActivityProgress } from '../lib/types';

/**
 * The student's activity screen.
 *
 * Deliberately outside the app shell: while a mandatory activity is
 * outstanding there is nowhere else to navigate to, so offering a nav bar
 * would only produce a loop of redirects.
 *
 * Time is *credited by the server* from the gap between heartbeats. Nothing
 * here reports a duration, because nothing here could be trusted to.
 */

const BEAT_MS = 15_000;

export default function ActivityRunner() {
  const { activityId } = useParams<{ activityId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { refresh: refreshGate } = useActivityGate();

  const [activity, setActivity] = useState<ActivityDetail | null>(null);
  const [index, setIndex] = useState(0);
  const [secondsSpent, setSecondsSpent] = useState(0);
  const [videoOpened, setVideoOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [finishing, setFinishing] = useState(false);
  const [done, setDone] = useState(false);

  // The furthest card reached, which is what the server is told about. Paging
  // backwards to re-read something must not undo progress.
  const furthest = useRef(0);
  const videoOpenedRef = useRef(false);

  const cards = useMemo(() => activity?.content?.cards ?? [], [activity]);
  const needsVideo = activity?.kind === 'VIDEO' || activity?.kind === 'MIXED';

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ activity: ActivityDetail; progress: ActivityProgress }>(
          `/api/activities/${activityId}`,
        );
        if (cancelled) return;
        setActivity(res.activity);
        setSecondsSpent(res.progress.secondsSpent);
        setVideoOpened(res.progress.videoOpened);
        videoOpenedRef.current = res.progress.videoOpened;
        // Resume where they left off rather than starting from card one.
        const resumeAt = Math.min(Math.max(res.progress.cardsSeen - 1, 0), Math.max(res.activity.cardCount - 1, 0));
        furthest.current = res.progress.cardsSeen;
        setIndex(resumeAt);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not open this activity.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activityId]);

  // Seeing the first card counts as seeing it.
  useEffect(() => {
    if (cards.length > 0 && furthest.current < 1) furthest.current = 1;
  }, [cards.length]);

  const beat = useCallback(async () => {
    if (!activityId || done) return;
    try {
      const res = await api.post<{ secondsSpent: number; cardsSeen: number }>(
        `/api/activities/${activityId}/progress`,
        { cardsSeen: furthest.current, videoOpened: videoOpenedRef.current },
      );
      setSecondsSpent(res.secondsSpent);
    } catch {
      // A dropped beat is not worth interrupting the student over; the next
      // one credits the whole gap anyway.
    }
  }, [activityId, done]);

  useEffect(() => {
    if (loading || done) return;
    const timer = setInterval(() => void beat(), BEAT_MS);
    return () => clearInterval(timer);
  }, [beat, loading, done]);

  // A local ticker so the countdown moves between beats. Display only - the
  // number that decides anything is the one the server sends back.
  useEffect(() => {
    if (loading || done || !activity?.minSeconds) return;
    const timer = setInterval(() => setSecondsSpent((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [loading, done, activity?.minSeconds]);

  if (loading) return <PageLoader label="Opening activity" />;

  if (!activity) {
    return (
      <div className="min-h-full grid place-items-center p-6">
        <div className="max-w-md w-full space-y-4 text-center">
          <Alert tone="error">{error ?? 'That activity is not available to you.'}</Alert>
          <button type="button" className="btn-secondary btn-sm" onClick={() => navigate('/dashboard')}>
            Back to dashboard
          </button>
        </div>
      </div>
    );
  }

  const total = cards.length;
  const secondsLeft = Math.max(0, activity.minSeconds - secondsSpent);
  const allCardsSeen = furthest.current >= total;
  const canFinish = allCardsSeen && secondsLeft === 0;

  const goTo = (next: number) => {
    const clamped = Math.min(Math.max(next, 0), Math.max(total - 1, 0));
    setIndex(clamped);
    if (clamped + 1 > furthest.current) {
      furthest.current = clamped + 1;
      void beat();
    }
  };

  const openVideo = () => {
    setVideoOpened(true);
    videoOpenedRef.current = true;
    void beat();
  };

  const finish = async () => {
    setFinishing(true);
    setError(null);
    try {
      // One last beat so the final stretch of reading is credited.
      await beat();
      const res = await api.post<{ remainingActivities: number; message: string }>(
        `/api/activities/${activity.id}/complete`,
      );
      setDone(true);
      await refreshGate();
      setNotice(res.message);
      // Straight on to the next one if they owe more, otherwise back to work.
      setTimeout(() => navigate('/dashboard', { replace: true }), 900);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not mark this as done.');
      // The server may know better than we do about the time spent.
      void beat();
    } finally {
      setFinishing(false);
    }
  };

  const card = cards[index];

  return (
    <div className="min-h-full flex flex-col bg-surface-sunken">
      <header className="sticky top-0 z-20 bg-surface/95 backdrop-blur border-b border-line">
        <div className="mx-auto max-w-3xl px-4 h-14 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-semibold truncate">{activity.title}</h1>
              {activity.isMandatory ? <Badge tone="warn">Required</Badge> : <Badge>Optional</Badge>}
            </div>
            <p className="text-[11px] text-ink-faint">
              {activity.publicId}
              {total > 0 && ` · card ${Math.min(index + 1, total)} of ${total}`}
            </p>
          </div>

          <div className="text-right shrink-0">
            {secondsLeft > 0 ? (
              <span className="text-xs text-ink-muted tabular-nums">
                {secondsLeft}s left before you can finish
              </span>
            ) : (
              <span className="text-xs text-good">Ready to finish</span>
            )}
            {!activity.isMandatory && (
              <button type="button" className="btn-ghost btn-sm ml-2" onClick={() => navigate('/dashboard')}>
                Close
              </button>
            )}
          </div>
        </div>
        {total > 0 && (
          <div className={`h-1 bg-line accent-${cards[index]?.accent ?? 'slate'}`}>
            <div
              className="h-full transition-all"
              style={{
                width: `${Math.round((Math.min(furthest.current, total) / total) * 100)}%`,
                background: 'var(--accent)',
              }}
            />
          </div>
        )}
      </header>

      <main className="flex-1 mx-auto w-full max-w-3xl px-4 py-6 space-y-4">
        {activity.isMandatory && (
          <Alert tone="info">
            {user?.firstName ? `${user.firstName}, please` : 'Please'} go through this before carrying on. Everything
            else is on hold until it is done.
          </Alert>
        )}

        {activity.description && <p className="text-sm text-ink-muted">{activity.description}</p>}

        {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}

        {needsVideo && <VideoPanel activity={activity} opened={videoOpened} onOpen={openVideo} />}

        {card && (
          <article className={`flashcard accent-${card.accent ?? 'slate'} min-h-[240px]`}>
            <div className="flashcard-bar" />
            <div className="flashcard-body">
              {card.eyebrow && <p className="flashcard-eyebrow">{card.eyebrow}</p>}
              {card.title && <h2 className="flashcard-title">{card.title}</h2>}
              <BlocksRenderer blocks={card.blocks} />
            </div>
          </article>
        )}

        {total > 1 && (
          <nav className="flex flex-wrap items-center gap-1.5" aria-label="Cards">
            {cards.map((c, i) => {
              const seen = i < furthest.current;
              return (
                <button
                  key={c.id ?? i}
                  type="button"
                  onClick={() => goTo(i)}
                  aria-current={i === index}
                  aria-label={`Card ${i + 1}${c.title ? `: ${c.title}` : ''}`}
                  className={`accent-${c.accent ?? 'slate'} w-9 h-9 rounded-lg text-xs border transition-colors ${
                    i === index
                      ? 'text-white font-semibold border-transparent'
                      : seen
                        ? 'font-medium'
                        : 'border-dashed text-ink-faint bg-surface-sunken'
                  }`}
                  style={
                    i === index
                      ? { background: 'var(--accent)' }
                      : seen
                        ? { background: 'var(--accent-soft)', borderColor: 'var(--accent-line)', color: 'var(--accent-ink)' }
                        : undefined
                  }
                >
                  {i + 1}
                </button>
              );
            })}
          </nav>
        )}
      </main>

      <footer className="sticky bottom-0 bg-surface/95 backdrop-blur border-t border-line">
        <div className="mx-auto max-w-3xl px-4 py-3 flex items-center justify-between gap-3">
          {total > 1 ? (
            <button type="button" className="btn-secondary btn-sm" onClick={() => goTo(index - 1)} disabled={index === 0}>
              Back
            </button>
          ) : (
            <span />
          )}

          <span className="text-[11px] text-ink-faint text-center flex-1">
            {!allCardsSeen
              ? `Read all ${total} cards to finish`
              : secondsLeft > 0
                ? 'Nearly there'
                : 'You can finish now'}
          </span>

          {index < total - 1 ? (
            <button type="button" className="btn-primary btn-sm" onClick={() => goTo(index + 1)}>
              Next
            </button>
          ) : (
            <button type="button" className="btn-primary btn-sm" onClick={() => void finish()} disabled={!canFinish || finishing || done}>
              {finishing ? 'Saving…' : done ? 'Done' : 'I have finished'}
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

/**
 * The video.
 *
 * Only YouTube and Vimeo are ever framed, and only their own player origins -
 * the server decides that in lib/video.ts and hands back an embed URL or
 * nothing at all. Anything else is an ordinary link that opens in a new tab,
 * which is honest about leaving the site.
 */
function VideoPanel({
  activity,
  opened,
  onOpen,
}: {
  activity: ActivityDetail;
  opened: boolean;
  onOpen: () => void;
}) {
  if (!activity.videoUrl) return null;

  if (activity.videoEmbedUrl) {
    return (
      <div className="card overflow-hidden">
        <div className="relative w-full" style={{ paddingTop: '56.25%' }}>
          <iframe
            src={activity.videoEmbedUrl}
            title={activity.title}
            className="absolute inset-0 w-full h-full"
            allow="accelerometer; encrypted-media; picture-in-picture; fullscreen"
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
            allowFullScreen
            onLoad={onOpen}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="card p-4 flex items-center justify-between gap-3 flex-wrap">
      <div className="min-w-0">
        <p className="text-sm font-medium">Watch the video</p>
        <p className="text-[11px] text-ink-faint break-all">{activity.videoUrl}</p>
      </div>
      <a
        href={activity.videoUrl}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="btn-primary btn-sm shrink-0"
        onClick={onOpen}
      >
        {opened ? 'Open again' : 'Open video'}
      </a>
    </div>
  );
}
