async function loadMeta(id) {
  const res = await fetch(
    `https://www.dailymotion.com/player/metadata/video/${id}`,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Referer": "https://www.dailymotion.com/",
        "Origin": "https://www.dailymotion.com",
        "Accept": "application/json"
      }
    }
  );

  if (!res.ok) {
    throw new Error(`Metadata isteği başarısız oldu (HTTP ${res.status})`);
  }

  return await res.text();
}

/* Python mantığına uygun Gelişmiş Manifest Arama */
function getManifest(responseText) {
  let m3u8Url = null;

  // 1. Önce Regex ile aramayı deneyelim
  const pattern = /(https?:\/\/[^\s"'<>]+cdndirector[^\s"'<>]*?\.m3u8[^\s"'<>]*)/;
  let match = responseText.match(pattern);

  if (!match) {
    const patternAlt = /(https?:\/\/[^\s"'<>]+?\.m3u8[^\s"'<>]*)/g;
    const allM3u8 = responseText.match(patternAlt) || [];
    const cdnMatch = allM3u8.find(url => url.includes("cdn"));
    if (cdnMatch) {
      match = [cdnMatch];
    }
  }

  if (match) {
    m3u8Url = match[1] || match[0];
  }

  // 2. Eğer regex bulamazsa, JSON parse edip qualities ve recursive arama yapalım
  if (!m3u8Url) {
    try {
      const data = JSON.parse(responseText);
      const qualities = data.qualities || {};
      let foundUrl = null;

      if (typeof qualities === "object" && qualities !== null) {
        for (const qList of Object.values(qualities)) {
          if (Array.isArray(qList)) {
            for (const item of qList) {
              if (item && typeof item.url === "string" && item.url.includes(".m3u8")) {
                foundUrl = item.url;
                break;
              }
            }
          }
          if (foundUrl) break;
        }
      }

      if (!foundUrl) {
        function searchJson(obj) {
          if (obj && typeof obj === "object") {
            for (const v of Object.values(obj)) {
              if (typeof v === "string" && v.includes(".m3u8")) {
                return v;
              }
              const res = searchJson(v);
              if (res) return res;
            }
          }
          return null;
        }
        foundUrl = searchJson(data);
      }

      if (foundUrl) {
        m3u8Url = foundUrl;
      }
    } catch (e) {
      // JSON parse edilemediyse geç
    }
  }

  if (m3u8Url) {
    try {
      m3u8Url = m3u8Url.replace(/\\/g, "");
    } catch (err) {}
  }

  return m3u8Url;
}

/* Proxy File (Segments / Media TS/MP4/AAC) */
async function proxyFile(fileUrl, request) {
  if (!fileUrl) {
    return new Response("URL parametresi eksik", { status: 400 });
  }

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Referer": "https://www.dailymotion.com/",
    "Origin": "https://www.dailymotion.com"
  };

  const range = request.headers.get("range");
  if (range) {
    headers["Range"] = range;
  }

  const upstream = await fetch(fileUrl, { headers });

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders
  });
}

/* Proxy Manifest (M3U8 rewrite) + Özel M3U8 Header'ları */
async function proxyManifest(manifestUrl, origin) {
  const m3u8_headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Referer": "https://www.dailymotion.com/",
    "Origin": "https://www.dailymotion.com"
  };

  const upstream = await fetch(manifestUrl, {
    headers: m3u8_headers
  });

  if (!upstream.ok) {
    return new Response(`Manifest alınamadı: ${upstream.status}`, { status: upstream.status });
  }

  let text = await upstream.text();
  const manifestBase = new URL(manifestUrl);

  const lines = text.split("\n");
  const rewrittenLines = lines.map(line => {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      return line;
    }

    let absoluteUrl;
    try {
      absoluteUrl = new URL(trimmed, manifestBase).href;
    } catch (e) {
      absoluteUrl = trimmed;
    }

    if (absoluteUrl.includes(".m3u8") || absoluteUrl.includes("type=m3u8")) {
      return `${origin}/proxy.m3u8?url=${encodeURIComponent(absoluteUrl)}`;
    }

    return `${origin}/seg?u=${encodeURIComponent(absoluteUrl)}`;
  });

  return new Response(rewrittenLines.join("\n"), {
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache"
    }
  });
}

export default {
  async fetch(request) {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/debug") {
        return new Response("DMTV RECURSIVE V2 OK");
      }

      if (url.pathname === "/seg") {
        const file = url.searchParams.get("u");
        return await proxyFile(file, request);
      }

      if (url.pathname === "/proxy.m3u8") {
        const manifest = url.searchParams.get("url");
        return await proxyManifest(manifest, url.origin);
      }

      const path = url.pathname.replace("/", "");
      if (!path) {
        return new Response("ID Bulunamadı", { status: 400 });
      }

      const id = path.replace(".json", "").replace(".m3u8", "");

      const rawText = await loadMeta(id);
      const manifest = getManifest(rawText);

      if (!manifest) {
        return Response.json({ error: "Manifest bulunamadı", rawText }, { status: 404 });
      }

      if (path.endsWith(".json")) {
        let parsedData = {};
        try { parsedData = JSON.parse(rawText); } catch(e) {}
        return Response.json({
          id,
          title: parsedData.title || "Bilinmiyor",
          manifest
        });
      }

      return await proxyManifest(manifest, url.origin);

    } catch (e) {
      return new Response(`Hata: ${e.message}`, {
        status: 500
      });
    }
  }
};
