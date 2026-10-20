"use client";

import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/field";
import { NicknameForm } from "@/components/nickname-form";
import type { LiveQuiz } from "@/lib/live-view";
import type { QuizOutcome } from "@/lib/quiz";
import { useT } from "@/lib/i18n/client";
import { NETWORK_ERROR, SERVER_ERROR } from "@/lib/copy";

/** One shape per option position, drawn in a 24-unit box; the colour token is in the CSS (`--quiz-1`..`--quiz-6`). */
export const QUIZ_SHAPES = [
  <polygon key="triangle" points="12,3 22,20 2,20" />,
  <circle key="circle" cx="12" cy="12" r="9" />,
  <rect key="square" x="4" y="4" width="16" height="16" />,
  <polygon key="diamond" points="12,2 22,12 12,22 2,12" />,
  <polygon key="star" points="12,2 14.9,8.6 22,9.3 16.6,14 18.2,21 12,17.3 5.8,21 7.4,14 2,9.3 9.1,8.6" />,
  <polygon key="hexagon" points="12,2 20.7,7 20.7,17 12,22 3.3,17 3.3,7" />,
];

const TICK_MS = 250;
/** How long a connected phone waits for its pushed result before it asks for it. */
const OUTCOME_FALLBACK_MS = 3000;
const ANNOUNCE_AT = [10, 5];

/**
 * Participant quiz question. The countdown runs on the server's `deadline_at`: the client clock is corrected by
 * the offset between the server's "now" in the payload and its own clock when the payload arrived. Seconds are
 * announced to screen readers at 10 and 5 only; the ticking number is hidden from them.
 */
export function QuizForm({ eventId, quiz, socket = null }: { eventId: string; quiz: LiveQuiz; socket?: Socket | null }) {
  const t = useT();
  const [selected, setSelected] = useState<string[]>(quiz.mine ?? []);
  const [sent, setSent] = useState(quiz.mine !== null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<QuizOutcome | "failed" | null>(null);
  // The payload's server time is "now" on arrival; later ticks add the offset between the two clocks.
  const [offset] = useState(() => quiz.serverNow - Date.now());
  const [now, setNow] = useState(quiz.serverNow);
  const [startSeconds] = useState(() => Math.max(0, Math.ceil(((quiz.deadlineAt ?? quiz.serverNow) - quiz.serverNow) / 1000)));
  const [timedOut, setTimedOut] = useState(false);
  const [nickname, setNickname] = useState(quiz.nickname);
  const [renaming, setRenaming] = useState(false);
  const renameButton = useRef<HTMLButtonElement>(null);
  const closed = quiz.state === "closed";
  const counting = quiz.state === "live" && quiz.deadlineAt !== null && !sent && !closed;
  const remainingMs = quiz.deadlineAt === null ? Infinity : quiz.deadlineAt - now;
  const secondsLeft = Math.max(0, Math.ceil(remainingMs / 1000));
  const timeUp = counting && (timedOut || remainingMs <= 0);
  const locked = sent || submitting || timeUp || closed;
  // The leaderboard needs a name before the first answer; it can change until that answer is sent.
  const needsName = !closed && nickname === null;
  const nameLocked = sent || quiz.nicknameLocked;
  const answering = !needsName && !renaming;
  const hintShown = !closed && !sent && !timeUp && answering;

  useEffect(() => {
    if (!counting) return;
    const id = window.setInterval(() => setNow(Date.now() + offset), TICK_MS);
    return () => window.clearInterval(id);
  }, [counting, offset]);

  // Back from renaming, focus returns to the button that opened it.
  const wasRenaming = useRef(false);
  useEffect(() => {
    if (wasRenaming.current && !renaming) renameButton.current?.focus();
    wasRenaming.current = renaming;
  }, [renaming]);

  // The server pushes each phone its own result when the question closes. The listener lives as long as the
  // form, so a message that follows `state-changed` closely is not missed while the closed state renders.
  useEffect(() => {
    if (!socket) return;
    const onOutcome = (msg: { interactionId: string; outcome: QuizOutcome }) => {
      if (msg.interactionId === quiz.id) setOutcome(msg.outcome);
    };
    socket.on("quiz:outcome", onOutcome);
    return () => void socket.off("quiz:outcome", onOutcome);
  }, [socket, quiz.id]);

  // The GET is the fallback for a phone that has no socket or missed the message.
  const hasOutcome = outcome !== null;
  useEffect(() => {
    if (!closed || hasOutcome) return;
    let cancelled = false;
    const load = () =>
      fetch(`/api/interactions/${quiz.id}/quiz-result`)
        .then(async (res) => {
          if (!res.ok) throw new Error(String(res.status));
          return (await res.json()) as QuizOutcome;
        })
        .then((body) => !cancelled && setOutcome((cur) => cur ?? body))
        .catch(() => !cancelled && setOutcome((cur) => cur ?? "failed"));
    const timer = window.setTimeout(() => void load(), socket ? OUTCOME_FALLBACK_MS : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [closed, hasOutcome, quiz.id, socket]);

  // Derived, so the live region changes text only on entering the 10 s and 5 s steps (and at zero).
  const announcement = !counting
    ? ""
    : timeUp
      ? t("quiz.timeUp")
      : secondsLeft <= ANNOUNCE_AT[1]
        ? t("quiz.secondsLeft", { n: Math.min(ANNOUNCE_AT[1], startSeconds) })
        : secondsLeft <= ANNOUNCE_AT[0]
          ? t("quiz.secondsLeft", { n: Math.min(ANNOUNCE_AT[0], startSeconds) })
          : "";

  const send = async (optionIds: string[]) => {
    if (locked || optionIds.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/interactions/${quiz.id}/quiz-answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ optionIds }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) setSent(true);
      else {
        // Another device already answered, or the window closed: the server's answer stands.
        if (res.status === 409 && body.error === t("api.alreadyAnswered")) setSent(true);
        else if (res.status === 409 && body.error === t("api.quizTimeUp")) setTimedOut(true);
        else setSelected([]);
        setError(body.error ?? SERVER_ERROR);
      }
    } catch {
      setSelected([]);
      setError(NETWORK_ERROR);
    } finally {
      setSubmitting(false);
    }
  };

  const choose = (id: string) => {
    if (locked) return;
    if (quiz.multiple) setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
    else {
      setSelected([id]);
      void send([id]);
    }
  };

  const correctIds = typeof outcome === "object" && outcome ? outcome.correctOptionIds : [];
  const mineIds = typeof outcome === "object" && outcome ? outcome.optionIds : selected;

  return (
    <div className="live-form quiz">
      {quiz.prompt && quiz.prompt !== quiz.title && <p className="quiz-prompt">{quiz.prompt}</p>}

      {closed && <QuizResult outcome={outcome} />}

      {counting && !timeUp && (
        <div className="quiz-timer" aria-hidden="true" data-urgent={secondsLeft <= 5}>
          <span className="quiz-timer-label">{t("quiz.timeLeft")}</span>
          <span className="quiz-timer-seconds">{secondsLeft}</span>
          <span className="quiz-timer-track">
            <span
              className="quiz-timer-fill"
              style={{ width: `${Math.min(100, Math.max(0, (remainingMs / (quiz.timeLimitSeconds * 1000)) * 100))}%` }}
            />
          </span>
        </div>
      )}
      {timeUp && (
        <p className="quiz-timeup">
          <strong>{t("quiz.timeUp")}</strong> {t("quiz.timeUpBody")}
        </p>
      )}

      {needsName && (
        <>
          {counting && !timeUp && <p className="field-meta">{t("quiz.nicknameTimerNote")}</p>}
          <NicknameForm eventId={eventId} initial={null} onSaved={setNickname} />
        </>
      )}
      {!needsName && !closed && nickname !== null && (
        renaming ? (
          <NicknameForm
            eventId={eventId}
            initial={nickname}
            keepName={nickname}
            onSaved={(next) => {
              setNickname(next);
              setRenaming(false);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <p className="quiz-player">
            <span>{t("quiz.playingAs", { name: nickname })}</span>
            {!nameLocked && (
              <Button ref={renameButton} type="button" variant="quiet" onClick={() => setRenaming(true)}>
                {t("quiz.nicknameChange")}
              </Button>
            )}
          </p>
        )
      )}

      {hintShown && (
        <p className="field-meta" id={`quiz-hint-${quiz.id}`}>
          {t(quiz.multiple ? "quiz.hintMany" : "quiz.hintOne")}
        </p>
      )}

      {(closed || answering) && (
        <ul className="quiz-options" aria-label={t("quiz.legend")}>
          {quiz.options.map((o, i) => {
            const mine = mineIds.includes(o.id);
            const right = closed && correctIds.includes(o.id);
            const tags = (
              <>
                {right && <span className="quiz-tag">{t("quiz.correctAnswer")}</span>}
                {mine && <span className="quiz-tag">{t(closed ? "quiz.yourAnswer" : "quiz.selected")}</span>}
              </>
            );
            const body = (
              <>
                <svg className="quiz-shape" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false">
                  {QUIZ_SHAPES[i % QUIZ_SHAPES.length]}
                </svg>
                <span className="quiz-option-text">{o.text}</span>
                {/* Whitespace between the spans keeps the accessible name "Java Selected", not "JavaSelected". */}
                {" "}
                {tags}
              </>
            );
            return (
              <li key={o.id}>
                {closed ? (
                  <div className="quiz-option" data-n={(i % 6) + 1}>
                    {body}
                  </div>
                ) : (
                  <button
                    type="button"
                    className="quiz-option"
                    data-n={(i % 6) + 1}
                    aria-pressed={quiz.multiple || sent ? mine : undefined}
                    aria-disabled={locked || undefined}
                    aria-describedby={hintShown ? `quiz-hint-${quiz.id}` : undefined}
                    data-selected={mine}
                    onClick={() => choose(o.id)}
                  >
                    {body}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {quiz.multiple && !closed && !sent && !timeUp && answering && (
        <Button
          type="button"
          variant="primary"
          busy={submitting}
          aria-disabled={selected.length === 0 || undefined}
          onClick={() => void send(selected)}
        >
          {submitting ? t("common.sending") : t("quiz.send")}
        </Button>
      )}
      {sent && !closed && (
        <p role="status" className="confirm">
          {t("quiz.sent")}
        </p>
      )}
      {error && <InlineError>{error}</InlineError>}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}

function QuizResult({ outcome }: { outcome: QuizOutcome | "failed" | null }) {
  const t = useT();
  if (outcome === null) {
    return (
      <p role="status" className="quiz-result">
        {t("quiz.resultLoading")}
      </p>
    );
  }
  if (outcome === "failed") return <InlineError>{t("quiz.resultFailed")}</InlineError>;
  const heading = !outcome.answered ? "quiz.resultNone" : outcome.correct ? "quiz.resultCorrect" : "quiz.resultWrong";
  return (
    <p role="status" className="quiz-result" data-correct={outcome.correct}>
      <strong>{t(heading)}</strong>
      <span className="quiz-result-points">
        {t(outcome.points === 1 ? "quiz.points.one" : "quiz.points.other", { n: outcome.points })}
      </span>
      {outcome.standing ? (
        <>
          <span className="quiz-result-rank">
            {t("leaderboard.yourRank", { rank: outcome.standing.rank, players: outcome.standing.players })}
          </span>
          {/* After the first question the total is the question's points; saying it twice adds nothing. */}
          {outcome.standing.points !== outcome.points && (
            <span className="quiz-result-points">
              {t("leaderboard.yourTotal", {
                points: t(outcome.standing.points === 1 ? "quiz.points.one" : "quiz.points.other", { n: outcome.standing.points }),
              })}
            </span>
          )}
        </>
      ) : (
        <span>{t("leaderboard.notRanked")}</span>
      )}
    </p>
  );
}
