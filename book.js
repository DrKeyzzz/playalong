// The built-in book on the live site: the tunes are locked (tunes.enc) and open with the class code.
// Locally (tunes.js loaded) this does nothing. The key is remembered in this browser after one unlock.
(function (root) {
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const toB64 = (u) => btoa(String.fromCharCode(...new Uint8Array(u)));
  let file = null;
  async function getFile() { if (!file) { const r = await fetch('tunes.enc', { cache: 'no-cache' }); if (!r.ok) throw new Error('no book file'); file = await r.json(); } return file; }
  async function decryptWith(key) {
    const f = await getFile();
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(f.iv) }, key, b64(f.data));
    return JSON.parse(new TextDecoder().decode(plain));
  }
  async function keyFromCode(code) {
    const f = await getFile();
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code.trim().toLowerCase()), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(f.salt), iterations: f.iterations || 200000 }, base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
  }
  const Book = {
    loaded() { return (root.TuneLibrary && root.TuneLibrary.TUNES.some((t) => !t.custom)); },
    // Try the remembered key. Returns the tunes, or null.
    async auto() {
      if (this.loaded()) return null;
      let saved = null; try { saved = localStorage.getItem('classKey'); } catch {}
      if (!saved) return null;
      try { const key = await crypto.subtle.importKey('raw', b64(saved), 'AES-GCM', false, ['decrypt']); return await decryptWith(key); }
      catch { try { localStorage.removeItem('classKey'); } catch {} return null; }
    },
    // Unlock with a code. Returns the tunes; throws 'wrong' for a wrong code.
    async unlock(code) {
      const key = await keyFromCode(code);
      let tunes;
      try { tunes = await decryptWith(key); } catch { throw new Error('wrong'); }
      try { localStorage.setItem('classKey', toB64(await crypto.subtle.exportKey('raw', key))); } catch {}
      return tunes;
    },
    forget() { try { localStorage.removeItem('classKey'); } catch {} }
  };
  root.Book = Book;
})(window);
