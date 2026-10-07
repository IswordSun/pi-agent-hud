/**
 * test/simulate-hud.ts — HUD 双运行时行为仿真。
 *
 * 用法: bun --preload ./test/preload-hud-stubs.ts test/simulate-hud.ts
 * (exit 0 = 全过)。不触网、不碰真实会话、不加载 bubble/overlay（它们依赖真实
 * CustomEditor/TUI 组件，属于端到端面，由真机验证）。
 *
 * 验证两条交付路径共用一个渲染体：
 *   - pi : ctx.ui.setFooter 捕获到组件，render(width) 产出各行；
 *   - omp: ctx.ui.setStatus 收到 hud-row-N 行（组件行被推到内建状态栏）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../extensions/agent-hud/config.ts";
import { createHudFooter } from "../extensions/agent-hud/hud-footer.ts";
import { formatWindowLabel, paintProvider } from "../extensions/agent-hud/layout.ts";
import { findPlanProvider, QuotaService } from "../extensions/agent-hud/quota.ts";
import { setDetectedRuntime } from "../extensions/agent-hud/runtime.ts";
import { SessionState } from "../extensions/agent-hud/state.ts";

type HudApi = Parameters<typeof createHudFooter>[0];
type HudCtx = Parameters<typeof createHudFooter>[1];

// ---------------------------------------------------------------------------
// 迷你 fake 运行时
// ---------------------------------------------------------------------------

interface FakeFooterComponent {
	render(width: number): string[];
	dispose(): void;
	invalidate(): void;
}

interface FakeSessionEntry {
	type: string;
	message?: { role: string; content?: unknown; usage?: unknown };
}

function makeSessionEntries(): FakeSessionEntry[] {
	return [];
}

/** 事件处理器注册表（pi.on 的最小面）。 */
function makeHandlers(): Map<string, Array<(event: unknown, ctx?: unknown) => unknown>> {
	return new Map();
}

function emit(handlers: Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>, name: string): void {
	for (const handler of handlers.get(name) ?? []) void handler({}, undefined);
}

/** 共享的 ExtensionAPI 假面（渲染用到的最小方法集）。 */
function makeApi(handlers: ReturnType<typeof makeHandlers>): HudApi {
	return {
		on(event: string, handler: (event: unknown, ctx?: unknown) => unknown): void {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		getAllTools: () => [],
		getCommands: () => [],
		getThinkingLevel: () => undefined,
	} as HudApi;
}

/** 共享的 ExtensionContext 假面（渲染用到的最小字段）。 */
function makeCtx(cwd: string, ui: unknown, provider = "anthropic"): HudCtx {
	const base = {
		cwd,
		hasUI: true,
		model: { id: "claude-test", provider, reasoning: false },
		getContextUsage: () => ({ percent: 39 }),
		sessionManager: {
			getCwd: () => cwd,
			getEntries: (): FakeSessionEntry[] => makeSessionEntries(),
		},
	};
	return { ...base, ui } as HudCtx;
}

function seedState(state: SessionState): void {
	state.toolCounts.set("Grep", 2);
	state.toolCounts.set("Bash", 1);
	state.runningTools.set("tool-1", { name: "Edit", startTime: Date.now() - 12_000 });
	state.lastUserInput = "how to build a REST API with auth?";
	state.inputHistory.push("how to build a REST API with auth?", "check docs");
	state.turnCount = 3;
	state.planSteps = [{ text: "read project", done: true }, { text: "implement api", done: false }];
	state.agentEntries.push({ id: "agent-1", status: "running", startTime: Date.now() - 5_000 });
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) {
		console.log(`  ok - ${name}`);
	} else {
		failures += 1;
		console.error(`  FAIL - ${name}${detail ? ` (${detail})` : ""}`);
	}
}

function stripMarkup(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/<[^>]*>/g, "");
}

// ---------------------------------------------------------------------------
// 场景 1: pi 运行时 — setFooter 捕获组件,render 产出 3 行
// ---------------------------------------------------------------------------

{
	const cwd = mkdtempSync(join(tmpdir(), "hud-sim-pi-"));
	setDetectedRuntime("pi");

	let captured: FakeFooterComponent | undefined;
	const theme = { fg: (_color: string, text: string) => text };
	const tui = { requestRender: () => {} };
	const footerData = { getGitBranch: () => "main", onBranchChange: () => () => {} };
	const ui = {
		setFooter(factory: (t: unknown, th: unknown, fd: unknown) => FakeFooterComponent): void {
			captured = factory(tui, theme, footerData) as FakeFooterComponent;
		},
	};

	const handlers = makeHandlers();
	const api = makeApi(handlers);
	const ctx = makeCtx(cwd, ui);
	const state = new SessionState();
	seedState(state);
	const quota = new QuotaService();

	createHudFooter(api, ctx, state, quota);

	check("pi: setFooter 捕获到组件", captured !== undefined);
	if (!captured) process.exit(1);

	const lines = captured.render(120).map(stripMarkup);
	const joined = lines.join("\n");
	check("pi: 输出 ≥2 行", lines.length >= 2, `got ${lines.length} line(s)`);
	check("pi: Line1 含 context 39%", /39%/.test(joined));
	check("pi: Line1 含 3 turn", joined.includes("3 turn"));
	check("pi: Line2 含 Grep ×2", joined.includes("Grep") && joined.includes("×2"));
	check("pi: Line3 含最近输入", lines.at(-1)?.includes("REST API") === true);
	check("pi: Line2 含运行中 Edit", joined.includes("Edit"));
	check("pi: 用量组含 provider 标签", joined.includes("anthropic"), joined.slice(0, 200));
}

// ---------------------------------------------------------------------------
// 场景 2: omp 运行时 — setFooter 是 noop,行被推到 setStatus(hud-row-N)
// ---------------------------------------------------------------------------

{
	const cwd = mkdtempSync(join(tmpdir(), "hud-sim-omp-"));
	setDetectedRuntime("omp");

	let capturedByFooter: unknown = undefined;
	const statuses = new Map<string, string>();
	const theme = { fg: (_color: string, text: string) => text };
	const ui = {
		setFooter: () => {
			capturedByFooter = "called"; // omp 下真实现是 noop;假面记下是否被调用(应为否)
		},
		setStatus(key: string, text: string | undefined): void {
			if (text === undefined) {
				statuses.delete(key);
			} else {
				statuses.set(key, text);
			}
		},
		theme,
	};

	const handlers = makeHandlers();
	const api = makeApi(handlers);
	const ctx = makeCtx(cwd, ui);
	const state = new SessionState();
	seedState(state);
	const quota = new QuotaService();

	createHudFooter(api, ctx, state, quota);

	check("omp: 未调用假 setFooter(真身 noop 语义)", capturedByFooter === undefined);
	const keys = [...statuses.keys()].sort();
	check("omp: 状态行键为 hud-row-N", keys.length >= 2 && keys.every((k) => /^hud-row-\d+$/.test(k)),
		`keys=${JSON.stringify(keys)}`);
	const joined = [...statuses.values()].join("\n");
	check("omp: 行内容含 context 39%", /39%/.test(joined));
	check("omp: 行内容含 Grep", joined.includes("Grep"));
	check("omp: 行内容含最近输入", joined.includes("REST API"));
	check("omp: 行内容含运行中 Edit", joined.includes("Edit"));

	// 触发 session_shutdown:清理应清空 hud-row 键
	emit(handlers, "session_shutdown");
	check("omp: shutdown 后状态行清空", statuses.size === 0, `leftover=${JSON.stringify([...statuses.keys()])}`);
}

// ---------------------------------------------------------------------------
// 场景 2b: omp 配额行 — 费用/余额/5h/周/月 单独成行(经典单列模式,quotaRow 自动开启)
// ---------------------------------------------------------------------------

{
	const cwd = mkdtempSync(join(tmpdir(), "hud-sim-omp-quota-"));
	setDetectedRuntime("omp");

	// HOME 指向空临时目录:resolveKey 找不到 key,quota 轮询不触网
	const savedHome = process.env.HOME;
	const savedProfile = process.env.USERPROFILE;
	process.env.HOME = cwd;
	process.env.USERPROFILE = cwd;
	try {
		const statuses = new Map<string, string>();
		const theme = { fg: (_color: string, text: string) => text };
		const ui = {
			setFooter: () => {},
			setStatus(key: string, text: string | undefined): void {
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
			theme,
		};

		const api = makeApi(makeHandlers());
		const entries: FakeSessionEntry[] = [
			{ type: "message", message: { role: "assistant", usage: { input: 1000, output: 500, cost: { total: 0.042 } } } },
		];
		const ctx = {
			...makeCtx(cwd, ui, "zhipu-coding-plan"),
			sessionManager: { getCwd: () => cwd, getEntries: () => entries },
		} as HudCtx;

		const state = new SessionState();
		seedState(state);
		const quota = new QuotaService();
		quota.setProvider("zhipu-coding-plan"); // 先定 provider,再种数据(同 provider 下 render 不再清空)
		quota.planUsage = {
			source: "zhipu-coding-plan",
			fiveHour: { usedPercent: 42, windowMinutes: 300, resetAt: Date.now() + 2 * 3600_000 },
			weekly: { usedPercent: 18, windowMinutes: 7 * 24 * 60, resetAt: Date.now() + 3 * 86400_000 },
			monthly: { usedPercent: 12, windowMinutes: 30 * 24 * 60, resetAt: Date.now() + 12 * 86400_000 },
			capturedAt: Date.now(),
		};
		quota.balanceInfo = { provider: "zhipu-coding-plan", label: "¥12.50", value: 12.5, currency: "CNY", capturedAt: Date.now() };

		createHudFooter(api, ctx, state, quota);

		const rows = [...statuses.keys()]
			.sort((a, b) => Number(a.slice("hud-row-".length)) - Number(b.slice("hud-row-".length)))
			.map((k) => stripMarkup(statuses.get(k) ?? ""));
		check("omp-quota: 输出 ≥3 行", rows.length >= 3, `got ${rows.length}`);
		const quotaRow = rows[1] ?? "";
		const rawQuotaRow = statuses.get("hud-row-1") ?? "";
		check("omp-quota: 配额行以 provider 开头(用量前)", quotaRow.startsWith("zhipu-coding-plan · $0.042"), quotaRow);
		check("omp-quota: provider 走调色板着色(141)", rawQuotaRow.startsWith("\x1b[38;5;141mzhipu-coding-plan\x1b[39m"), JSON.stringify(rawQuotaRow.slice(0, 60)));
		check("omp-quota: 配额行含费用 $0.042", quotaRow.includes("$0.042"), quotaRow);
		check("omp-quota: 配额行含余额 💰 ¥12.50", quotaRow.includes("💰 ¥12.50"), quotaRow);
		check("omp-quota: 配额行含 5h 用量", /⏳5h 42%/.test(quotaRow), quotaRow);
		check("omp-quota: 配额行含周用量", /📅wk 18%/.test(quotaRow), quotaRow);
		check("omp-quota: 配额行含月用量", /🗓mo 12%/.test(quotaRow), quotaRow);
		check("omp-quota: 统计行不含余额/用量", !/💰|⏳5h|📅wk|🗓mo/.test(rows[2] ?? ""));
		check("omp-quota: 配额行不含工具统计", !quotaRow.includes("Grep"));
		check("omp-quota: Line1 不含费用(已抽出)", !(rows[0] ?? "").includes("$0.042"));
	} finally {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		if (savedProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = savedProfile;
	}
}

// ---------------------------------------------------------------------------
// 场景 3: GLM Coding Plan — zhipu-coding-plan 匹配 + 月度窗口解析与渲染
// ---------------------------------------------------------------------------

{
	setDetectedRuntime("pi");
	const cwd = mkdtempSync(join(tmpdir(), "hud-sim-glm-"));

	// 3a. provider id 匹配：omp 的 GLM Coding Plan provider 是 zhipu-coding-plan
	const glmSpec = findPlanProvider("zhipu-coding-plan");
	check("glm: zhipu-coding-plan 命中 GLM 配额 spec", glmSpec?.url.includes("open.bigmodel.cn") === true);
	check("glm: zai-coding-cn 命中同一 spec", findPlanProvider("zai-coding-cn") === glmSpec);

	// 3b. 真实响应形状（2026-09 实测）：TIME_LIMIT 月窗 + TOKENS_LIMIT 5h/周窗
	const realJson = {
		data: {
			limits: [
				{ type: "TIME_LIMIT", unit: 5, number: 1, usage: 1000, currentValue: 30, remaining: 970, percentage: 3, nextResetTime: 1789880030997 },
				{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1, nextResetTime: 1788633382470 },
				{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 1, nextResetTime: 1789188830998 },
			],
		},
	};
	const parsed = glmSpec?.parse(realJson);
	check("glm: 解析出 5h 窗口", parsed?.fiveHour?.windowMinutes === 300 && parsed?.fiveHour?.usedPercent === 1);
	check("glm: 解析出周窗口（1 周）", parsed?.weekly?.windowMinutes === 7 * 24 * 60);
	check(
		"glm: 解析出月度窗口",
		parsed?.monthly?.windowMinutes === 30 * 24 * 60
			&& parsed?.monthly?.usedPercent === 3
			&& parsed?.monthly?.resetAt === 1789880030997,
	);
	check("glm: formatWindowLabel 月窗 → mo", formatWindowLabel(30 * 24 * 60) === "mo");
	check("glm: formatWindowLabel 周窗仍为 wk", formatWindowLabel(7 * 24 * 60) === "wk");

	// 3c. HUD 渲染三个窗口。HOME 指向空临时目录：resolveKey 找不到 key，测试不触网。
	const savedHome = process.env.HOME;
	const savedProfile = process.env.USERPROFILE;
	process.env.HOME = cwd;
	process.env.USERPROFILE = cwd;
	try {
		let captured: FakeFooterComponent | undefined;
		const theme = { fg: (_color: string, text: string) => text };
		const tui = { requestRender: () => {} };
		const footerData = { getGitBranch: () => "main", onBranchChange: () => () => {} };
		const ui = {
			setFooter(factory: (t: unknown, th: unknown, fd: unknown) => FakeFooterComponent): void {
				captured = factory(tui, theme, footerData) as FakeFooterComponent;
			},
		};

		const api = makeApi(makeHandlers());
		const ctx = makeCtx(cwd, ui, "zhipu-coding-plan");
		const state = new SessionState();
		seedState(state);
		const quota = new QuotaService();
		quota.setProvider("zhipu-coding-plan");
		quota.planUsage = {
			source: "zhipu-coding-plan",
			fiveHour: { usedPercent: 42, windowMinutes: 300, resetAt: Date.now() + 2 * 3600_000 },
			weekly: { usedPercent: 18, windowMinutes: 7 * 24 * 60, resetAt: Date.now() + 3 * 86400_000 },
			monthly: { usedPercent: 12, windowMinutes: 30 * 24 * 60, resetAt: Date.now() + 12 * 86400_000 },
			capturedAt: Date.now(),
		};

		createHudFooter(api, ctx, state, quota);
		check("glm: setFooter 捕获到组件", captured !== undefined);
		if (!captured) process.exit(1);
		const joined = captured.render(200).map(stripMarkup).join("\n");
		check("glm: HUD 显示 5h 用量", /⏳5h 42%/.test(joined), joined.slice(0, 200));
		check("glm: HUD 显示周用量", /📅wk 18%/.test(joined));
		check("glm: HUD 显示月用量", /🗓mo 12%/.test(joined));
	} finally {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		if (savedProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = savedProfile;
	}
}

// ---------------------------------------------------------------------------
// 场景 4: 配置按运行时隔离 — pi 的全局配置不能关掉 omp 的配额元素
// ---------------------------------------------------------------------------

{
	const home = mkdtempSync(join(tmpdir(), "hud-sim-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "hud-sim-proj-"));
	const piAgent = join(home, ".pi", "agent");
	const ompAgent = join(home, ".omp", "agent");
	const projOmp = join(cwd, ".omp");
	const savedHome = process.env.HOME;
	const savedProfile = process.env.USERPROFILE;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	try {
		mkdirSync(piAgent, { recursive: true });
		mkdirSync(ompAgent, { recursive: true });
		mkdirSync(projOmp, { recursive: true });
		writeFileSync(join(piAgent, "pi-agent-hud.json"), JSON.stringify({ disabled: ["balance", "plan5h"] }));

		// 4a. omp 一个自有配置都没有 → 回退读 pi（迁移期，不制造回归）
		setDetectedRuntime("omp");
		let cfg = loadConfig(cwd);
		check("config: omp 无自有配置时回退 pi 配置", cfg.disabled?.join(",") === "balance,plan5h", JSON.stringify(cfg));

		// 4b. omp 写了历史名 → 不再读 pi；历史名生效
		writeFileSync(join(ompAgent, "pi-agent-hud.json"), JSON.stringify({ disabled: ["model"] }));
		cfg = loadConfig(cwd);
		check("config: omp 有自有配置后与 pi 隔离", cfg.disabled?.join(",") === "model", JSON.stringify(cfg));

		// 4c. 规范名 omp-agent-hud.json 覆盖历史名
		writeFileSync(join(ompAgent, "omp-agent-hud.json"), JSON.stringify({ disabled: ["thinking"] }));
		cfg = loadConfig(cwd);
		check("config: omp-agent-hud.json 覆盖历史名", cfg.disabled?.join(",") === "thinking", JSON.stringify(cfg));

		// 4d. 项目级覆盖全局（同运行时内后读覆盖先读）
		writeFileSync(join(projOmp, "omp-agent-hud.json"), JSON.stringify({ disabled: ["project"] }));
		cfg = loadConfig(cwd);
		check("config: omp 项目级覆盖全局", cfg.disabled?.join(",") === "project", JSON.stringify(cfg));

		// 4e. pi 不读 omp 的配置
		setDetectedRuntime("pi");
		cfg = loadConfig(cwd);
		check("config: pi 只看 .pi/pi-agent-hud.json", cfg.disabled?.join(",") === "balance,plan5h", JSON.stringify(cfg));
	} finally {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		if (savedProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = savedProfile;
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// 场景 5: omp 的 provider id 命中配额 spec（kimi-code / minimax-cn）
// ---------------------------------------------------------------------------

{
	const kimi = findPlanProvider("kimi-code");
	check("omp-id: kimi-code 命中 Kimi 配额 spec", kimi?.url.includes("api.kimi.com") === true, kimi?.url ?? "none");
	check("omp-id: kimi 与 kimi-code 同一 spec", findPlanProvider("kimi") === kimi);
	check("omp-id: minimax-cn 命中 MiniMax 配额 spec", findPlanProvider("minimax-cn")?.url.includes("minimaxi.com") === true);
}

// ---------------------------------------------------------------------------
// 场景 6: OpenCode Go 订阅 — provider 匹配 + /zen/go/v1/usage 三窗口解析与渲染
// ---------------------------------------------------------------------------

{
	const spec = findPlanProvider("opencode-go");
	check("opencode-go: 命中配额 spec", spec?.url === "https://opencode.ai/zen/go/v1/usage", spec?.url ?? "none");
	check("opencode-go: Zen 按量付费(opencode-zen)不误命中", findPlanProvider("opencode-zen") === undefined);

	// 真实响应形状（2026-10-06 实测）：percent = 已用百分比，resetsAt = ISO8601
	const realJson = {
		usage: {
			rolling: { status: "ok", percent: 0, resetsAt: "2026-10-06T13:22:32.000Z" },
			weekly: { status: "ok", percent: 5, resetsAt: "2026-10-12T00:00:00.000Z" },
			monthly: { status: "ok", percent: 3, resetsAt: "2026-11-03T07:35:23.000Z" },
		},
	};
	const parsed = spec?.parse(realJson);
	check(
		"opencode-go: rolling → 5h 窗口",
		parsed?.fiveHour?.usedPercent === 0 && parsed?.fiveHour?.windowMinutes === 300,
		JSON.stringify(parsed?.fiveHour),
	);
	check("opencode-go: weekly → 周窗口", parsed?.weekly?.usedPercent === 5 && parsed?.weekly?.windowMinutes === 7 * 24 * 60, JSON.stringify(parsed?.weekly));
	check(
		"opencode-go: monthly → 月窗口 + ISO 重置时间",
		parsed?.monthly?.usedPercent === 3
			&& parsed?.monthly?.windowMinutes === 30 * 24 * 60
			&& parsed?.monthly?.resetAt === Date.parse("2026-11-03T07:35:23.000Z"),
		JSON.stringify(parsed?.monthly),
	);
	check(
		"opencode-go: 标签 5h/wk/mo",
		formatWindowLabel(300) === "5h" && formatWindowLabel(7 * 24 * 60) === "wk" && formatWindowLabel(30 * 24 * 60) === "mo",
	);
	check("opencode-go: 缺 usage 字段 → undefined", spec?.parse({}) === undefined);

	// 调色板：收录的 provider 着色，其余交回调用方（footer 用 accent / bubble 用整段配色）
	check("paint: 收录 provider 返回 ANSI 色", paintProvider("deepseek", "deepseek") === "\x1b[38;5;39mdeepseek\x1b[39m", String(paintProvider("deepseek", "deepseek")));
	check("paint: 未收录 provider → undefined(调用方回退)", paintProvider("no-such-provider", "x") === undefined);
	check("paint: 尾部复位为默认前景(39)而非全复位", paintProvider("kimi", "kimi")?.endsWith("\x1b[39m") === true);

	// 渲染：种入解析结果，三窗口以 ⏳5h / 📅wk / 🗓mo 出现
	setDetectedRuntime("pi");
	const cwd = mkdtempSync(join(tmpdir(), "hud-sim-ocgo-"));
	const savedHome = process.env.HOME;
	const savedProfile = process.env.USERPROFILE;
	process.env.HOME = cwd;
	process.env.USERPROFILE = cwd;
	try {
		let captured: FakeFooterComponent | undefined;
		const theme = { fg: (_color: string, text: string) => text };
		const tui = { requestRender: () => {} };
		const footerData = { getGitBranch: () => "main", onBranchChange: () => () => {} };
		const ui = {
			setFooter(factory: (t: unknown, th: unknown, fd: unknown) => FakeFooterComponent): void {
				captured = factory(tui, theme, footerData) as FakeFooterComponent;
			},
		};

		const api = makeApi(makeHandlers());
		const ctx = makeCtx(cwd, ui, "opencode-go");
		const state = new SessionState();
		seedState(state);
		const quota = new QuotaService();
		quota.setProvider("opencode-go"); // 先定 provider,再种数据(同 provider 下 render 不再清空)
		if (parsed) quota.planUsage = { source: "opencode-go", ...parsed, capturedAt: Date.now() };

		createHudFooter(api, ctx, state, quota);
		check("opencode-go: setFooter 捕获到组件", captured !== undefined);
		if (captured) {
			const joined = captured.render(200).map(stripMarkup).join("\n");
			check("opencode-go: HUD 显示 5h 用量", /⏳5h 0%/.test(joined), joined.slice(0, 200));
			check("opencode-go: HUD 显示周用量", /📅wk 5%/.test(joined));
			check("opencode-go: HUD 显示月用量", /🗓mo 3%/.test(joined));
			const usageLine = joined.split("\n").find((l) => l.includes("⏳")) ?? "";
			check("opencode-go: provider 标签在用量窗口之前", usageLine.includes("opencode-go · ⏳5h"), usageLine);
			const rawUsageLine = captured.render(200).find((l) => l.includes("⏳")) ?? "";
			check("opencode-go: provider 走调色板着色(45)", rawUsageLine.includes("\x1b[38;5;45mopencode-go\x1b[39m"), JSON.stringify(rawUsageLine.slice(0, 80)));
		}
	} finally {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		if (savedProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = savedProfile;
		rmSync(cwd, { recursive: true, force: true });
	}
}

setDetectedRuntime(null);
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
