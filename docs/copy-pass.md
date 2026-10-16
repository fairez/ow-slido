# Copy pass (US-032)

Reviewed every user-facing string against the Voice section of `DESIGN.md` and the antislop copywriting skill. A grep over `app`, `components` and `lib` found no exclamation marks, emoji or buzzwords in UI text. The changes below are the only ones needed.

## Centralised

`lib/copy.ts` now holds the two error messages that were repeated in 13 files with three different wordings.

| Constant | Text | Replaces |
| --- | --- | --- |
| `SERVER_ERROR` | That did not work on our side. Try again in a moment. | "Something went wrong. Please try again." |
| `NETWORK_ERROR` | Could not reach the server. Check your connection and try again. | "Network error. Please try again." and the same sentence written out in each file |

## Reworded

| Before | After | Why |
| --- | --- | --- |
| Not joined | Join the event first, then try again. | Says what to do. |
| Too many requests | Too many requests. Wait a moment, then try again. | Says what to do. |
| Slow down a little, then try again. | Too many posts in a row. Wait a moment, then try again. | Names the cause. |
| Please keep questions respectful | That question contains language we can't accept | Matches the wording used for notes and responses. |
| Email already registered | That email already has an account. Log in instead. | Says what to do. |
| Invalid email or password | Email or password is incorrect. | Plainer. |

No behaviour changed; status codes and response shapes are the same.
