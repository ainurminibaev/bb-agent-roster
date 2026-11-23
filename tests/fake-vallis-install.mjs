#!/usr/bin/env node
// A fake platform installer entry for tests (install-state.md, format 1; examples copied from the
// document). Not the real installer: it installs nothing, it only answers --describe and writes the
// state file by a scenario. Scenario: env FAKE_VALLIS_SCENARIO = normal | human | error | stuck |
// cancel | unknown-step | format2 | no-format. State dir: env FAKE_VALLIS_DIR (default: a temp dir).
// Step pace: env FAKE_VALLIS_STEP_MS (default 300). Names are made up.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const scenario = process.env.FAKE_VALLIS_SCENARIO || "normal";
const pace = Number(process.env.FAKE_VALLIS_STEP_MS || 300);

if (argv.includes("--describe")) {
  // install-state.md, «Форма ввода данными» — letter for letter.
  process.stdout.write(JSON.stringify({
    format: scenario === "format2" ? 2 : 1,
    fields: [
      { id: "organization", title: "Организация", hint: "git-адрес репозитория организации", type: "string", required: true, default: null },
      { id: "employee", title: "Сотрудник", hint: "описание из employees/ организации", type: "choice", required: true, default: null,
        choices: [{ value: "support", title: "Поддержка" }, { value: "developer", title: "Разработчик" }] },
      { id: "provider", title: "Модель агента", type: "choice", required: false, default: "codex",
        choices: [{ value: "codex", title: "Codex" }, { value: "claude-code", title: "Claude Code" }] },
      { id: "allowGuestGuard", title: "Сразу разрешить защиту гостей в Codex", type: "bool", default: false },
      { id: "telegramBot", title: "Токен бота Telegram", type: "secret", required: true,
        hint: "не вводится здесь: выдаётся через хранилище доступов на шаге «ключи»", secret: "TELEGRAM_BOT" },
    ],
  }, null, 2) + "\n");
  process.exit(0);
}

const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const employee = arg("--employee") || "support";
const dir = process.env.FAKE_VALLIS_DIR || join(tmpdir(), "fake-vallis-install", employee);
mkdirSync(dir, { recursive: true });
const file = join(dir, "state.json");
process.stdout.write(JSON.stringify({ state: file }) + "\n");

const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
const run = { id: `r-${Date.now()}`, startedAt: iso(Date.now()), heartbeatAt: iso(Date.now()), interval: Number(process.env.FAKE_VALLIS_INTERVAL || 15) };
const steps = [
  { id: "environment", title: "Проверка сервера", state: "pending" },
  { id: "account", title: "Своя учётка Linux сотрудника", state: "pending" },
  { id: "server", title: "Подготовка сервера: BB, агент, служба", state: "pending" },
  ...(scenario === "unknown-step" ? [{ id: "x-new-step", title: "Новый шаг установщика", state: "pending" }] : []),
  { id: "guest-guard", title: "Защита гостевых разговоров", state: "pending" },
  { id: "speech", title: "Служба речи", state: "pending" },
  { id: "mcp", title: "Подключения MCP", state: "pending" },
  { id: "chat", title: "Личка владельца с ботом", state: "pending" },
];
let overall = "running";
let result = null;
function write() {
  run.heartbeatAt = iso(scenario === "stuck" ? Date.parse(run.startedAt) - 3600_000 : Date.now());
  const doc = { format: scenario === "format2" ? 2 : 1, kind: "employee", for: employee, installer: "0.0.0-fake", state: overall, run, steps, tools: { format: 1, tools: [] }, result };
  if (scenario === "no-format") delete doc.format;
  writeFileSync(`${file}.tmp`, JSON.stringify(doc, null, 2));
  renameSync(`${file}.tmp`, file);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("SIGTERM", () => {
  const cur = steps.find((x) => x.state === "running" || x.state === "human");
  if (cur) { cur.state = "cancelled"; delete cur.human; }
  overall = "cancelled";
  write();
  process.exit(0);
});

for (const step of steps) {
  step.state = "running";
  write();
  await sleep(pace);
  if (scenario === "stuck" && step.id === "server") process.exit(0); // gone without a word: heartbeat stays old
  if (step.id === "guest-guard" && (scenario === "human" || scenario === "cancel") && !argv.includes("--allow-guest-guard")) {
    // install-state.md, the `human` step example — letter for letter.
    step.state = "human";
    step.human = { what: "Разрешить хук в Codex", how: "карточка «Codex hooks» в BB сотрудника или кнопка ниже",
      actions: [{ kind: "retry", title: "Разрешить и продолжить", params: { allowGuestGuard: true } },
                { kind: "cancel", title: "Отменить установку" }] };
    overall = "human";
    write();
    for (;;) { await sleep(1000); write(); } // waits until stopped (TERM) or run again with the parameter
  }
  if (step.id === "speech") { step.state = "skipped"; step.detail = "на этом сервере не нужна"; write(); continue; }
  if (step.id === "mcp" && scenario === "error") {
    step.state = "error";
    step.error = { text: "сервер задач не ответил за 30 с", retry: true, log: ["connect tasks.example.com:443 …", "timeout after 30 s"] };
    overall = "error";
    write();
    process.exit(1);
  }
  step.state = "done";
  write();
}
overall = "done";
result = {
  address: { machine: "host_example", port: 38800, project: "proj_example", workspace: `/home/${employee}/work` },
  role: { name: "Тестовый сотрудник", kind: "agent", about: "отвечает на вопросы клиентов (пример)" },
  links: [{ kind: "bb", url: "https://bb.example.org" }, { kind: "telegram", bot: "@example_test_bot" }],
  passport: `/home/${employee}/work/passport.json`,
};
write();
