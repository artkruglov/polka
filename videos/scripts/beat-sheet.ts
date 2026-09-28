// The beat sheet from a film's cues.ts: what happens on which bar and beat.
const [film] = process.argv.slice(2);
const { CUES, DURATION } = await import(`../src/films/${film}/cues.ts`);
const beat = 60 / 132; // 132 BPM
const where = (s: number) => { const i = Math.round(s / beat * 4) / 4; return `такт ${Math.floor(i / 4) + 1}, доля ${(i % 4) + 1}`; };
const rows: [number, string][] = [];
for (const [name, value] of Object.entries(CUES)) {
  const list = Array.isArray(value) ? value : [value];
  list.forEach((s: number, i: number) => rows.push([s, list.length > 1 ? `${name}[${i}]` : name]));
}
rows.sort((a, b) => a[0] - b[0]);
console.log(`| Секунда | Такт | Событие |\n|---|---|---|`);
for (const [s, name] of rows) console.log(`| ${s.toFixed(2)} | ${where(s)} | ${name} |`);
console.log(`\nДлительность: ${DURATION} с.`);
