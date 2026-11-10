/**
 * The web database file: the upgrade of a version-1 database (from before the profile photo), and
 * a deleted profile photo really leaving the database files (secure_delete and a checkpoint).
 * Real SQLite files in a temporary folder; invented data only.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SecretBox } from "../../src/web/crypto.js";
import { openDatabase } from "../../src/web/db.js";
import { Store } from "../../src/web/store.js";

const JPEG_START = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
/** An invented "photo" of about 560 KB (it fills many overflow pages) with a text to look for. */
const photo = (text: string) => Buffer.concat([JPEG_START, Buffer.from(text.repeat(20_000))]);

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "padi-mcp-db-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("web database", () => {
  it("upgrades a version-1 database: no photo and no check yet, and the photo goes with the user", () => {
    const dir = tempDir();
    const box = new SecretBox(randomBytes(32));
    // A version-1 database: today's schema without what version 2 added, with one user in it.
    let db = openDatabase(dir);
    const id = new Store(db, box).createUser("diver.one@example.com", "invented-hash", false).id;
    db.exec(`DROP TABLE avatars;
      ALTER TABLE users DROP COLUMN avatar_at;
      ALTER TABLE users DROP COLUMN avatar_checked_at;
      ALTER TABLE users DROP COLUMN avatar_check_failed;
      PRAGMA user_version = 1;`);
    db.close();

    db = openDatabase(dir);
    try {
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
      expect(db.prepare("SELECT avatar_at, avatar_checked_at, avatar_check_failed FROM users WHERE id = ?").get(id)).toEqual({
        avatar_at: null,
        avatar_checked_at: null,
        avatar_check_failed: 0,
      });
      const store = new Store(db, box);
      const user = store.getUser(id)!;
      expect(user.avatarAt).toBeUndefined();
      expect(user.avatarCheckedAt).toBeUndefined();
      expect(user.avatarCheckFailed).toBeUndefined();
      expect(store.getAvatar(id)).toBeUndefined();

      const data = photo("upgrade");
      const at = store.saveAvatar(id, { data, type: "image/jpeg" });
      expect(at).toBeGreaterThan(0);
      expect(store.getAvatar(id)?.data.equals(data)).toBe(true);
      // Foreign keys are on: the photo goes with the user.
      store.deleteUser(id);
      expect(db.prepare("SELECT COUNT(*) AS n FROM avatars").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it("wipes a deleted or replaced photo from the database files, not only from the table", () => {
    const dir = tempDir();
    const db = openDatabase(dir);
    try {
      expect(db.prepare("PRAGMA secure_delete").get()).toEqual({ secure_delete: 1 });
      const store = new Store(db, new SecretBox(randomBytes(32)));
      const inFiles = (text: string) =>
        ["padi-mcp.db", "padi-mcp.db-wal"]
          .map((name) => path.join(dir, name))
          .filter((file) => existsSync(file))
          .some((file) => readFileSync(file).includes(text));
      const user = (n: number) => store.createUser(`diver.${n}@example.com`, "invented-hash", false).id;
      const save = (id: string, text: string) => {
        store.saveAvatar(id, { data: photo(text), type: "image/jpeg" });
        expect(inFiles(text), text).toBe(true);
      };

      // A new photo replaces the old one; then PADI has none.
      const a = user(1);
      save(a, "INVENTED-PHOTO-A1;");
      save(a, "INVENTED-PHOTO-A2;");
      expect(inFiles("INVENTED-PHOTO-A1;")).toBe(false);
      store.saveAvatar(a, undefined);
      expect(inFiles("INVENTED-PHOTO-A2;")).toBe(false);

      // The PADI connection is removed.
      const b = user(2);
      save(b, "INVENTED-PHOTO-B;");
      store.savePadiSettings(b, undefined);
      expect(store.getAvatar(b)).toBeUndefined();
      expect(inFiles("INVENTED-PHOTO-B;")).toBe(false);

      // The account becomes a demo account.
      const c = user(3);
      save(c, "INVENTED-PHOTO-C;");
      expect(store.setDemo(c, true)).toBe(true);
      expect(inFiles("INVENTED-PHOTO-C;")).toBe(false);

      // The account is deleted.
      const d = user(4);
      save(d, "INVENTED-PHOTO-D;");
      store.deleteUser(d);
      expect(inFiles("INVENTED-PHOTO-D;")).toBe(false);
    } finally {
      db.close();
    }
  });
});
