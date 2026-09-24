/* Settings: the Полка address, the page button, connect and disconnect. */
import { matchPattern, normaliseOrigin } from "../shared/origin.ts";

type Status = {
  polkaOrigin: string;
  pageButton: boolean;
  connected: boolean;
  version: string;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const connection = $("connection");
const connect = $<HTMLButtonElement>("connect");
const disconnect = $<HTMLButtonElement>("disconnect");
const connectionError = $("connection-error");
const origin = $<HTMLInputElement>("origin");
const originError = $("origin-error");
const pageButton = $<HTMLInputElement>("page-button");

const send = <T>(message: unknown) => chrome.runtime.sendMessage<T>(message);

function show(status: Status) {
  const host = new URL(status.polkaOrigin).host;
  connection.textContent = status.connected
    ? `Подключено к ${host}. Расширение может сохранять работы и выдавать ссылки.`
    : `Не подключено к ${host}.`;
  connect.hidden = status.connected;
  disconnect.hidden = !status.connected;
  origin.value = status.polkaOrigin;
  pageButton.checked = status.pageButton;
}

async function refresh() {
  show(await send<Status>({ type: "status" }));
}

connect.addEventListener("click", async () => {
  connect.disabled = true;
  connectionError.hidden = true;
  const answer = await send<{ ok: boolean; message?: string }>({ type: "connect" });
  connect.disabled = false;
  if (!answer?.ok) {
    connectionError.textContent = answer?.message ?? "Не подключено.";
    connectionError.hidden = false;
  }
  await refresh();
});

disconnect.addEventListener("click", async () => {
  disconnect.disabled = true;
  await send({ type: "disconnect" });
  disconnect.disabled = false;
  await refresh();
});

$("origin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  originError.hidden = true;
  const next = normaliseOrigin(origin.value);
  if (!next) {
    originError.textContent = "Нужен адрес https:// (или http://localhost для своей установки на этом компьютере).";
    originError.hidden = false;
    return;
  }
  // Access to a self-hosted Полка is asked for here, on the user's click.
  const granted = await chrome.permissions.request({ origins: [matchPattern(next)] });
  if (!granted) {
    originError.textContent = "Без доступа к этому адресу расширение не сможет сохранять на него.";
    originError.hidden = false;
    return;
  }
  show(await send<Status>({ type: "settings", settings: { polkaOrigin: next } }));
});

pageButton.addEventListener("change", async () => {
  show(await send<Status>({ type: "settings", settings: { pageButton: pageButton.checked } }));
});

void refresh();
