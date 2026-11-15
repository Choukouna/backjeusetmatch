# Flutter / NestJS migration contracts

Source inspected: `/home/choukouna/Documents/Formations/Practice/clone_github/jeusetmatch`. Existing local changes there were preserved. Flutter's `lib/db/crud.dart` contains most readers/writers; `lib/db/user_provider.dart` reads players directly, and `lib/ui/logging/commune.dart` reads communes directly. Firebase Auth routing and FCM lifecycle stay client-side. This backend does not change that repository or ship a new mobile release.

## Existing storage contracts

| Collection                          | Existing behavior / backend mapping                                                                                                                                                                                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `players`                           | Firebase UID is document ID. Lowercase pseudo/city, `deptCode`, sport preferences, ranking strings (`NC` corresponds to numerator 50), `wins/losses`, `bestWin/worstDefeat`, `fcmToken` as legacy string or array. Self profile exposes private fields; discovery never does. |
| `communes`                          | Prefix search on `nameNormalized`; `departmentCode` is distinct from player `deptCode`. Public for signup.                                                                                                                                                                    |
| `matches`                           | `player1Id/player2Id`, winner, `score` JSON string with `gamesA/gamesB`, `playDate`, comment. JA opponents are existing rank-specific player records such as `ja30` and `ja30_1`; look them up with authenticated pseudo search. Both participants can read matches.          |
| `players_slot`                      | `ownerUid`, `deptCode`, `participants`, `start/end`, one sport, `location.stade/city/nbRequis`, `AVAILABLE/PENDING/ACCEPTED`. Owner date slots run today through day +14, whole hours 08–21, one-hour duration; backend uses Europe/Paris.                                    |
| `friend_requests`                   | Sorted `${uid1}_${uid2}` ID; `fromUid/fromName/toUid/toName/status`. Only the recipient accepts; either party removes.                                                                                                                                                        |
| `chats` / `messages`                | Sorted pair ID and `type=P2P`; group chat shares group document ID and `type=GROUP`. `participants` contains `{uid,name}`; `participantsUid` governs access. Messages retain `content/senderId/senderName/createdAt`; chat summary retains last message/readers.              |
| `groups`                            | `ownerUid/name`; membership is on its chat. Owner adds accepted friends and deletes; other members can leave. Owner must delete rather than leave an ownerless group.                                                                                                         |
| `tournaments` / `tournament_rounds` | Tennis `RR`, `OPEN/ONGOING/COMPLETED`, participants, group linkage, scheduled match IDs, byes. Private group owner creates/closes; public leagues are provisioned externally and participants close after starting. Results are normalized to scheduled player order.         |
| `notifications_to_send`             | Existing external sender receives `{title,body,toFcmToken,status:PENDING,createdAt}`. Queue writes commit with backend mutations; no push sender runs here. Slot recipients retain department/sport/frequency filtering and legacy token fallbacks.                           |
| `user_feedbacks`                    | Retain `{userId,feedback,createdAt}`. API request field `message` is mapped explicitly.                                                                                                                                                                                       |

Backend-only `_api_slot_reservations` serialize a player’s bookings across different slot documents; `_api_operations` records deduplicate retries; `_pseudo_reservations` serializes registrations from new clients while checking existing player records. Direct client access to these collections must stay denied. Neither mechanism prevents old Flutter clients from bypassing new backend invariants.

Chat retains Dart encrypt's AES-256 SIC/CTR + PKCS7 format: `base64(iv):base64(ciphertext)`. Plaintext legacy records remain readable; ciphertext errors use the existing French fallback. This shared-key scheme is not end-to-end encryption. Keep the original key throughout coexistence; do not rotate or change the format without a separate migration.

## Frontend integration sequence

1. Introduce a central API transport with an environment-specific base URL and Firebase ID-token header. Map stable API error codes to French `Constante` entries; retain operation IDs until a mutation is confirmed. Do not log credentials or tokens.
2. Migrate profiles, `UserProvider`, department/city discovery, commune autocomplete, device tokens, notification preferences, and app-open tracking. Preserve Future-based reads and explicitly refresh affected caches after saves.
3. Migrate pseudo login/signup/reset/profile completion and account deletion. Retain Firebase session handling. Test signup interruption recovery; never expose pseudo-to-email lookup to the client.
4. Migrate feedback, friendships, standalone matches/statistics, then availability. Remove client-side statistics writes for migrated match submissions so results are counted once.
5. Migrate groups, messages, read markers, and chat previews. Replace Firestore streams with REST snapshots plus authenticated SSE invalidations. Send plaintext over TLS to NestJS; NestJS encrypts persisted content. Render REST plaintext directly rather than decrypting it again.
6. Migrate leagues, scheduled scoring, standings, and public enrollment. Remove client schedule/statistics writes for migrated flows. Preserve bottom navigation stacks, scroll state, unfinished forms, and cancellation-versus-save refresh semantics.

Use exactly one writer per feature per app version. Ship test builds after each step, verify through a dedicated Firebase test project, then stage mobile releases. Older installed versions continue to use the same records and the existing notification sender; backend listeners see their writes.

The initial backend limits new groups to 30 members and newly generated round-robin schedules to 28 players so related writes fit one Firestore transaction. Existing larger leagues remain readable; expanding atomic scheduling beyond that needs a separate job design. These limits are exposed as validation errors rather than silently producing partial schedules.

## Compatibility and retirement gates

- Existing Firestore rules/indexes and the actual notification Cloud Function must be obtained and reviewed before production rollout. They are not present in the inspected Flutter repo. Emulator tests do not establish production index availability or old-client authorization safety.
- Direct writes from legacy versions can still duplicate statistics, race slot reservations, or claim a pseudo concurrently with the new API. Do not claim global exactly-once behavior while legacy writers remain.
- New API authentication and authorization are stricter than client-only checks. Verify the owner/member restrictions, Paris slot timezone, score orientation, anonymous players, and completed-league behavior in frontend test builds.
- Cursors use document IDs for most lists and timestamp/document order for message/commune search and calendars. Deleting a timestamp-paginated cursor document invalidates the cursor; reload the snapshot. Filtered pages may be empty with a continuation cursor.
- Deletion marks chats/groups as deleting before cleanup and can be retried. Older direct clients do not honor backend tombstones; only retire their write access after an explicit supported-version decision. Historical stats follow the existing deletion behavior and are not recomputed when group matches are removed.
- No production data rewrite is needed for the API launch. Retire direct Firestore access, tighten client rules, and remove old Flutter database logic only after a separate version-retirement decision and a verified updated frontend release.

## Validation evidence

Unit tests cover ranks/NC, score orientation/ambiguity, Paris/DST slot boundaries, padel capacity, round-robin pair uniqueness/byes, standings, and a ciphertext fixture generated with the current Flutter Dart encryption dependency. HTTP tests cover public/protected boundaries and schema validation. Emulator integration tests cover signup recovery, private-field projection, scoped cursors, concurrent pseudo/match/slot/enrollment races, notification payloads, legacy chat data, live membership removal, and league score normalization.

Production deployment, Flutter UI tests, real notification delivery, and real multi-instance Cloud Run behavior require the configured test environment and frontend integration; emulator results do not substitute for those checks.

## Frontend integration contract additions

Player responses include `displayName` (first name and surname initial); full names remain self-only. Self profiles include `lastScreenTime` for existing unread behavior. `GET /players/me/activity` returns boolean `pendingSlotRequests`, `slotResponses`, and `newSlots`, computed from authenticated identity and its stored last-screen time. Optional first names remain accepted at registration.
