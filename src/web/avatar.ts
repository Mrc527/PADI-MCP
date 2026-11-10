/**
 * Keeps each user's profile photo up to date: the photo on the certification cards of their PADI
 * account, which the PADI website shows as the user's picture (src/padi/photo.ts).
 *
 * The photo is checked when the account page is opened: right after the PADI connection changes,
 * then once a day. The page waits a few seconds at most; a slower check finishes in the
 * background and the photo shows on the next page. PADI is asked through the user's own services
 * (the service pool), so a refreshed sign-in is saved as for tool calls, and a sign-in that
 * stopped working marks the connection "needs reconnect".
 */

import { PadiAuthError } from "../padi/auth.js";
import { PadiHttpError } from "../padi/http.js";
import { PhotoLinkError, PROFILE_PHOTO_TYPES } from "../padi/photo.js";
import type { ServicePool } from "./accounts.js";
import type { Store, User } from "./store.js";

const DAY = 86_400_000;
/** A failed check (PADI down, the photo host unreachable) is tried again after this time. */
const RETRY_AFTER_FAILURE = 60 * 60_000;

/** The photo types /account/avatar serves. */
export const PHOTO_TYPES: ReadonlySet<string> = PROFILE_PHOTO_TYPES;

/** Why a check failed, for the log: never a link, a token or an e-mail address. */
function failureReason(error: unknown): string {
  if (error instanceof PhotoLinkError) return error.reason;
  if (error instanceof PadiHttpError) {
    if (error.status !== undefined) return `HTTP ${error.status}`;
    return error.kind === "timeout" ? "no answer in time" : error.kind === "network" ? "no answer" : "the answer was not JSON";
  }
  if (error instanceof PadiAuthError) return "PADI sign-in refused";
  return "no answer";
}

export class AvatarService {
  /**
   * The running check of each user, with the PADI connection it is for. A page joins it only
   * for the same connection: after a reconnect it starts a new check.
   */
  private readonly running = new Map<string, { serviceUpdatedAt: number | undefined; job: Promise<number | undefined> }>();
  /** Every running check, also one replaced in `running` after a reconnect (for idle()). */
  private readonly jobs = new Set<Promise<number | undefined>>();

  constructor(
    private readonly store: Store,
    private readonly pool: ServicePool,
    private readonly log: (m: string) => void,
  ) {}

  /**
   * Whether PADI should be asked again for this user's photo. Never for a demo account, nor
   * without a PADI connection or while its sign-in needs to be renewed.
   */
  due(user: User, at = Date.now()): boolean {
    if (!user.hasPadi || user.padiNeedsReconnect || user.demo) return false;
    const checked = user.avatarCheckedAt;
    if (checked === undefined) return true;
    if ((user.serviceUpdatedAt ?? 0) > checked) return true;
    return at - checked >= (user.avatarCheckFailed ? RETRY_AFTER_FAILURE : DAY);
  }

  /**
   * Check the photo if due, waiting at most `waitMs`. Returns the user's avatarAt afterwards (the
   * old value when the check is still running).
   */
  async refresh(user: User, waitMs = 4000): Promise<number | undefined> {
    if (!this.due(user)) return user.avatarAt;
    const current = this.running.get(user.id);
    let job = current && current.serviceUpdatedAt === user.serviceUpdatedAt ? current.job : undefined;
    if (!job) {
      // A check never fails the page (for example when the database closes at shutdown).
      const started: Promise<number | undefined> = this.check(user.id)
        .catch(() => user.avatarAt)
        .finally(() => {
          this.jobs.delete(started);
          // A newer check (after a reconnect) keeps its place.
          if (this.running.get(user.id)?.job === started) this.running.delete(user.id);
        });
      job = started;
      this.running.set(user.id, { serviceUpdatedAt: user.serviceUpdatedAt, job });
      this.jobs.add(job);
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), waitMs);
    });
    try {
      const result = await Promise.race([job, timeout]);
      return result === "timeout" ? user.avatarAt : result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Wait for running checks, at most `maxMs` (tests and shutdown). */
  async idle(maxMs = 3000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, maxMs);
    });
    await Promise.race([Promise.allSettled([...this.jobs]), limit]);
    clearTimeout(timer);
  }

  private async check(userId: string): Promise<number | undefined> {
    const user = this.store.getUser(userId);
    // A demo account has no PADI account to ask: nothing may reach PADI for it.
    if (!user?.hasPadi || user.padiNeedsReconnect || user.demo) return user?.avatarAt;
    let backend;
    try {
      backend = this.pool.get(user)?.services.backend;
    } catch {
      // The stored connection cannot be read (the account page says so): nothing to ask with.
      return user.avatarAt;
    }
    if (!backend) return user.avatarAt;
    const startedAt = Date.now();
    // A connection saved while this check runs makes it due again (it is newer than startedAt).
    const stillCurrent = () => {
      const now = this.store.getUser(userId);
      return !!now?.hasPadi && now.serviceUpdatedAt === user.serviceUpdatedAt;
    };
    try {
      const photo = await backend.getProfilePhoto({ note: (reason) => this.log(`No profile photo: ${reason}`) });
      if (!stillCurrent()) return this.store.getUser(userId)?.avatarAt;
      return this.store.saveAvatar(userId, photo, startedAt);
    } catch (error) {
      this.log(`Profile photo check failed (${failureReason(error)}); trying again later`);
      if (stillCurrent()) this.store.markAvatarChecked(userId, startedAt, true);
      return this.store.getUser(userId)?.avatarAt;
    }
  }
}
