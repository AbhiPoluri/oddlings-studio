'use client';
/**
 * A picture of every spec that has been opened, kept between sessions.
 *
 * `localStorage` is where the recipe library keeps its thumbnails and it is the
 * wrong place for these: that library holds a few dozen entries a person chose
 * to save, while this is one image per file in `specs/` — seventeen of them in
 * this project already — against a quota measured in single-digit megabytes and
 * shared with everything else the page stores. IndexedDB has room, stores the
 * data URL as a string without a second encode, and is asynchronous, so filling
 * the cache never blocks a frame the viewport is drawing.
 *
 * Everything here is best effort by construction. A private window, a browser
 * with storage switched off, a quota that is already full: all of those are a
 * studio with no pictures in the Projects list, which is a studio that works.
 */

const DB_NAME = 'oddlings-studio';
const STORE = 'thumbs';
/**
 * What building each spec said about it, beside the picture of it.
 *
 * Same reasoning as the thumbnails and the same key, so the two are invalidated
 * together: reopening the studio on a folder of seventeen specs should not cost
 * seventeen builds to fill in a column of triangle counts that have not
 * changed since yesterday.
 */
const STATS = 'stats';
const VERSION = 2;
/** Enough for a folder that has been reviewed for a while, not for a leak. */
const LIMIT = 240;

type Record_ = { key: string; url: string; at: number };

/**
 * The copy the panel reads.
 *
 * Synchronous on purpose: a list rendering thirty rows cannot await each one,
 * and a row that has to wait a microtask for a picture it already has flickers.
 */
const cache = new Map<string, string>();
const listeners = new Set<() => void>();
let opening: Promise<IDBDatabase | null> | null = null;
let filled = false;

/** What a picture is of: the file, at the version that was drawn. */
export function thumbKey(path: string, modified: string): string {
  return `${path}|${modified}`;
}

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise((done) => {
    if (typeof indexedDB === 'undefined') return done(null);
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, VERSION);
    } catch {
      return done(null);
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      // Additive on purpose: a studio upgrading from version 1 keeps every
      // thumbnail it has already drawn.
      if (!db.objectStoreNames.contains(STORE))
        db.createObjectStore(STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STATS))
        db.createObjectStore(STATS, { keyPath: 'key' });
    };
    request.onsuccess = () => done(request.result);
    request.onerror = () => done(null);
    // A browser that never answers — a private window mid-prompt — must not
    // leave the panel waiting on a picture for the life of the page.
    setTimeout(() => done(null), 3000);
  });
  return opening;
}

function announce() {
  for (const listener of listeners) listener();
}

/** Subscribe to "a picture landed". Returns the unsubscribe, for an effect. */
export function watchThumbs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whatever has been read so far. Empty until `fillThumbs` has resolved once. */
export function thumbOf(key: string): string | undefined {
  return cache.get(key);
}

/** Read the whole store into memory, once per page. */
export async function fillThumbs(): Promise<void> {
  if (filled) return;
  filled = true;
  const db = await open();
  if (!db) return;
  await new Promise<void>((done) => {
    try {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      request.onsuccess = () => {
        for (const row of (request.result ?? []) as Record_[])
          if (row?.key && typeof row.url === 'string') cache.set(row.key, row.url);
        done();
      };
      request.onerror = () => done();
    } catch {
      done();
    }
  });
  if (cache.size) announce();
}

/**
 * Keep one picture.
 *
 * The in-memory copy is written first and the store is told afterwards: the
 * list should show the thumbnail of the spec you just opened in the same frame
 * you opened it, whether or not this browser has anywhere to put it.
 */
export async function putThumb(key: string, url: string): Promise<void> {
  cache.set(key, url);
  announce();
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.put({ key, url, at: Date.now() } satisfies Record_);
    // Trimmed here rather than on a timer, because this is the only moment the
    // store can have grown.
    if (cache.size > LIMIT) {
      const all = store.getAll();
      all.onsuccess = () => {
        const rows = ((all.result ?? []) as Record_[]).sort((a, b) => a.at - b.at);
        for (const row of rows.slice(0, rows.length - LIMIT)) {
          store.delete(row.key);
          cache.delete(row.key);
        }
      };
    }
  } catch {
    // A full quota is a studio without pictures, not a studio with an error.
  }
}

/**
 * Shrink a captured frame to the size the list draws it at.
 *
 * The viewport's own canvas is however many pixels wide the centre column is,
 * and storing that for every spec is a megabyte a row. 160×100 is the card, at
 * the one aspect the list uses.
 */
export const THUMB = { width: 160, height: 100 } as const;

export function shrink(dataUrl: string): Promise<string> {
  return new Promise((done) => {
    if (!dataUrl || typeof window === 'undefined') return done('');
    const image = new window.Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = THUMB.width;
        canvas.height = THUMB.height;
        const context = canvas.getContext('2d');
        if (!context) return done('');
        // Letterboxed rather than stretched: the viewport is whatever shape the
        // window is, and squashing a tall creature into a card is a worse
        // picture than one with a little space either side of it.
        const scale = Math.min(
          THUMB.width / image.width,
          THUMB.height / image.height,
        );
        const width = image.width * scale;
        const height = image.height * scale;
        context.drawImage(
          image,
          (THUMB.width - width) / 2,
          (THUMB.height - height) / 2,
          width,
          height,
        );
        done(canvas.toDataURL('image/png'));
      } catch {
        done('');
      }
    };
    image.onerror = () => done('');
    image.src = dataUrl;
  });
}

/**
 * The measurements the Projects list shows, cached the same way the pictures
 * are.
 *
 * Deliberately a separate store rather than another field on the thumbnail
 * row: a spec can be measured without ever being photographed, and a row that
 * had to carry an empty picture to record a triangle count would make the two
 * invalidate each other.
 */
export type SpecStats = {
  tris: number;
  ok: boolean;
  meshes: number;
  bones: number;
};

const measured = new Map<string, SpecStats>();
let read = false;

export function statsOf(key: string): SpecStats | undefined {
  return measured.get(key);
}

/** Read the whole measurement store into memory, once per page. */
export async function fillStats(): Promise<void> {
  if (read) return;
  read = true;
  const db = await open();
  if (!db) return;
  await new Promise<void>((done) => {
    try {
      const request = db.transaction(STATS, 'readonly').objectStore(STATS).getAll();
      request.onsuccess = () => {
        for (const row of (request.result ?? []) as (SpecStats & { key: string })[])
          if (row?.key && typeof row.tris === 'number')
            measured.set(row.key, {
              tris: row.tris,
              ok: row.ok,
              meshes: row.meshes,
              bones: row.bones,
            });
        done();
      };
      request.onerror = () => done();
    } catch {
      done();
    }
  });
  if (measured.size) announce();
}

export async function putStats(key: string, value: SpecStats): Promise<void> {
  measured.set(key, value);
  announce();
  const db = await open();
  if (!db) return;
  try {
    db
      .transaction(STATS, 'readwrite')
      .objectStore(STATS)
      .put({ key, ...value, at: Date.now() });
  } catch {
    // A full quota is a studio that measures again next time, not an error.
  }
}
