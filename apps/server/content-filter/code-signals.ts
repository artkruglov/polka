// Intent signals in a page's code (docs/specs/CONTENT_FILTER.md,
// «Вредоносный код»). The sandbox already stops the effects (no network, no
// Полка cookies, no top navigation, popups or downloads in the interactive
// view, no eval; the static view runs no page script at all), so this scan
// looks for what the author meant to do to a recipient: mine on their CPU,
// hand them an executable, escape or phone home, fingerprint them, hang the
// tab. The code is never run.
//
// Linear: each pattern is a plain substring counted with indexOf, or a regex
// with bounded repetition over one script at a time. A signal counts once
// per document; single weak signals stay below the threshold on purpose:
// every minified bundle has a for(;;) and a long string.

export type CodeSignal = { id: string; label: string; weight: number };

const count = (haystack: string, needle: string, limit = 1000) => {
  let n = 0;
  for (
    let at = haystack.indexOf(needle);
    at !== -1 && n < limit;
    at = haystack.indexOf(needle, at + needle.length)
  )
    n++;
  return n;
};

const MINERS = [
  "coinhive",
  "coin-hive",
  "cryptonight",
  "stratum+tcp",
  "stratum+ssl",
  "cryptoloot",
  "webminepool",
  "minero.cc",
  "xmrig",
  "coinimp",
  "webmr.js",
  "deepminer",
];
const FINGERPRINT_PROPS = [
  "hardwareConcurrency",
  "deviceMemory",
  "navigator.platform",
  "navigator.plugins",
  "navigator.languages",
  "maxTouchPoints",
  "navigator.webdriver",
  "getTimezoneOffset",
  "screen.colorDepth",
];
const EXECUTABLE = /\.(?:exe|apk|bat|cmd|scr|msi|dmg|ps1|vbs|jar|com|pif)$/i;

/** Signals of one script (inline, a bundle file or an event handler). */
export function scanCode(source: string, found: Map<string, CodeSignal>) {
  const add = (id: string, label: string, weight: number) => {
    if (!found.has(id)) found.set(id, { id, label, weight });
  };
  if (!source) return;
  const lower = source.length <= 8_000_000 ? source.toLowerCase() : "";
  // Mining: names of miners and pool protocols are not ambiguous.
  for (const miner of MINERS)
    if (lower.includes(miner)) {
      add("miner", `майнер или пул майнинга («${miner}»)`, 10);
      break;
    }
  // Obfuscation.
  if (/eval\s{0,3}\(\s{0,3}function\s{0,3}\(\s{0,3}p\s{0,3},\s{0,3}a\s{0,3},\s{0,3}c\s{0,3},\s{0,3}k\s{0,3},\s{0,3}e\s{0,3},\s{0,3}[dr]\s{0,3}\)/.test(source))
    add("packer", "упаковщик eval(function(p,a,c,k,e,d))", 4);
  if (count(source, "fromCharCode") >= 20)
    add("fromcharcode", "цепочки String.fromCharCode", 3);
  if (count(source, "\\x", 2000) >= 800 || count(source, "\\u00", 2000) >= 800)
    add("escapes", "текст, спрятанный в \\x-последовательности", 3);
  // Escape and egress attempts: blocked by the sandbox, but they show intent.
  if (/(?:top|parent)\s{0,3}\.\s{0,3}location\s{0,3}(?:\.\s{0,3}href\s{0,3})?=[^=]/.test(source))
    add("top-navigation", "попытка увести вкладку (top/parent.location)", 3);
  if (source.includes("RTCPeerConnection"))
    add("webrtc", "WebRTC (RTCPeerConnection)", 3);
  if (/new\s{1,3}WebSocket\s{0,3}\(\s{0,3}["'`]wss?:\/\//.test(source))
    add("websocket", "WebSocket на внешний сервер", 3);
  if (source.includes("sendBeacon(")) add("beacon", "navigator.sendBeacon", 2);
  if (/(?:fetch|\.open)\s{0,3}\(\s{0,3}(?:["'`][A-Z]{3,7}["'`]\s{0,3},\s{0,3})?["'`]https?:\/\//.test(source))
    add("external-request", "запрос на внешний адрес (fetch/XHR)", 2);
  if (source.includes("navigator.serviceWorker"))
    add("service-worker", "регистрация service worker", 2);
  if (/document\s{0,3}\.\s{0,3}cookie\s{0,3}=[^=]/.test(source))
    add("cookie-write", "запись document.cookie", 2);
  if (/postMessage\s{0,3}\([^)]{0,200}["'`]\*["'`]\s{0,3}\)/.test(source) &&
    /password|passwd|token|cvv|card|парол/i.test(source))
    add("postmessage-secrets", "postMessage('*') рядом с паролями или картами", 3);
  // Fingerprinting burst.
  const props = FINGERPRINT_PROPS.filter((prop) => source.includes(prop)).length;
  if (source.includes("toDataURL") && /(?:Offline)?AudioContext/.test(source) && props >= 5)
    add("fingerprint", "снятие отпечатка браузера (canvas, audio, свойства navigator)", 3);
  // Hanging the tab.
  if (/while\s{0,3}\(\s{0,3}(?:true|1|!0)\s{0,3}\)\s{0,3}\{?\s{0,3}(?:alert|confirm|prompt|window\.open|history\.pushState)/.test(source))
    add("tab-dos", "бесконечный цикл с диалогами или окнами", 4);
  if (/new\s{1,3}Array\s{0,3}\(\s{0,3}(?:1e(?:9|1\d)|\d{10,})\s{0,3}\)/.test(source))
    add("memory-bomb", "огромное выделение памяти", 3);
  // A large inline WebAssembly module next to instantiate: typical of miners.
  if (source.includes("WebAssembly.instantiate") && /["'`][A-Za-z0-9+/=]{200000}/.test(source))
    add("inline-wasm", "большой встроенный WebAssembly", 4);
  // An executable handed to the recipient from a blob.
  if (source.includes("createObjectURL") && /\.download\s{0,3}=\s{0,3}["'`][^"'`]{1,200}\.(?:exe|apk|bat|cmd|scr|msi|dmg|ps1|vbs|jar)["'`]/i.test(source))
    add("executable-download", "скачивание исполняемого файла из скрипта", 10);
}

/** An <a download> of an executable from a data: or blob: address. */
export function executableDownload(href: string, download: string) {
  const target = href.trim().toLowerCase();
  return (
    (target.startsWith("data:") || target.startsWith("blob:")) &&
    EXECUTABLE.test(download.trim())
  );
}
