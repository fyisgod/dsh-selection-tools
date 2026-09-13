window.__ModuleLoader__.load({
	id: "dsh-selection-tools",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/shared/protocol.ts
		/** 插件自有 HTTP 路由前缀（host half 注册，client half fetch）。 */
		const API_PREFIX = "/api/dsh-selection-tools";
		/** 一次划词请求允许的最大字符数（超出直接拒绝，避免意外把整篇文档塞给模型）。 */
		const MAX_SELECTION_LENGTH = 12e3;
		/** 上下文段落允许的最大字符数（系统级取词用 UIA 读选区所在段落，超长直接截断）。 */
		const MAX_CONTEXT_LENGTH = 4e3;
		/** 解析一帧 SSE 的 data 负载；不是本协议的帧返回 undefined。 */
		function parseRunEvent(raw) {
			try {
				const value = JSON.parse(raw);
				if (value === null || typeof value !== "object") return void 0;
				if (typeof value.type !== "string") return void 0;
				return value;
			} catch {
				return;
			}
		}
		/** "跟随原文自动"（中文→英文，其余→中文）——保留旧行为的那个选项。 */
		const AUTO_LANGUAGE_ID = "auto";
		/** 可选语言（覆盖常用语种；加语言只需在这里加一行）。 */
		const LANGUAGES = [
			{
				id: "zh-Hans",
				label: "简体中文",
				prompt: "Simplified Chinese"
			},
			{
				id: "zh-Hant",
				label: "繁體中文",
				prompt: "Traditional Chinese"
			},
			{
				id: "en",
				label: "English",
				prompt: "English"
			},
			{
				id: "ja",
				label: "日本語",
				prompt: "Japanese"
			},
			{
				id: "ko",
				label: "한국어",
				prompt: "Korean"
			},
			{
				id: "fr",
				label: "Français",
				prompt: "French"
			},
			{
				id: "de",
				label: "Deutsch",
				prompt: "German"
			},
			{
				id: "es",
				label: "Español",
				prompt: "Spanish"
			},
			{
				id: "pt",
				label: "Português",
				prompt: "Portuguese"
			},
			{
				id: "ru",
				label: "Русский",
				prompt: "Russian"
			},
			{
				id: "it",
				label: "Italiano",
				prompt: "Italian"
			},
			{
				id: "nl",
				label: "Nederlands",
				prompt: "Dutch"
			},
			{
				id: "pl",
				label: "Polski",
				prompt: "Polish"
			},
			{
				id: "sv",
				label: "Svenska",
				prompt: "Swedish"
			},
			{
				id: "tr",
				label: "Türkçe",
				prompt: "Turkish"
			},
			{
				id: "uk",
				label: "Українська",
				prompt: "Ukrainian"
			},
			{
				id: "ar",
				label: "العربية",
				prompt: "Arabic"
			},
			{
				id: "he",
				label: "עברית",
				prompt: "Hebrew"
			},
			{
				id: "fa",
				label: "فارسی",
				prompt: "Persian"
			},
			{
				id: "hi",
				label: "हिन्दी",
				prompt: "Hindi"
			},
			{
				id: "bn",
				label: "বাংলা",
				prompt: "Bengali"
			},
			{
				id: "th",
				label: "ไทย",
				prompt: "Thai"
			},
			{
				id: "vi",
				label: "Tiếng Việt",
				prompt: "Vietnamese"
			},
			{
				id: "id",
				label: "Bahasa Indonesia",
				prompt: "Indonesian"
			},
			{
				id: "ms",
				label: "Bahasa Melayu",
				prompt: "Malay"
			}
		];
		/** 取语言选项（未知 id 返回 undefined）。 */
		function languageById(id) {
			return LANGUAGES.find((item) => item.id === id);
		}
		/** 解释规则默认文本。 */
		const DEFAULT_EXPLAIN_RULES = [
			"- 结合语境解释选中的文本：它指什么、在这里起什么作用。",
			"- 先用一两句话说明它的含义，再分小节说明关键概念与背景；如果是代码，说明它的作用与执行过程。",
			"- 用 Markdown 组织回答，简洁准确，不要整段复述选中的文本或上文。",
			"- 不要评论有没有提供上文、也不要说明你是怎么判断语境的，直接给出解释。",
			"- 这是一次独立请求：只解释选中的文本，不要提及或评论任何先前的对话内容。"
		].join("\n");
		/**
		* 翻译规则默认文本。
		*
		* 词/短语按词典条目给（最佳翻译 + 音标 + 其他翻译 + 术语说明），句子/段落给整段译文
		* 并额外解释其中的关键术语与缩写——这些都靠规则驱动，模型自己判断是词还是句。
		*/
		const DEFAULT_TRANSLATE_RULES = [
			"- 先判断选中的是「词/短语」还是「句子/段落」，按对应格式输出。",
			"- 词或短语：按词典条目排版——",
			"  - 第一行：**最佳翻译**（最贴合当前语境的那一个译法）。",
			"  - 第二行：读音，写成 `英 /…/　美 /…/`（国际音标；中文等非表音文字可省略这一行）。",
			"  - 空一行后给 `其他翻译`：2~4 个其他义项，每条一行，写成 `- 译法 — 词性/领域，什么时候用`。",
			"  - 如果它是关键术语或缩写：再给一小节 `术语说明`，缩写先写全称，再用一句话说明它指什么。",
			"- 句子或段落：先给完整译文；如果句中出现了关键术语、缩写或专有名词，再追加小节 `关键术语`，逐条给出全称与一句解释（没有就不写这一节，不要硬凑）。",
			"- 只输出译文与上述小节：不要前言、不要复述原文、不要说明你是怎么判断词还是句子的。",
			"- 保留原文的格式、换行、行内代码与专有名词；如果原文已经是目标语言，原样返回。"
		].join("\n");
		/** 默认设置。 */
		const DEFAULT_SETTINGS = {
			targetLanguage: AUTO_LANGUAGE_ID,
			fallbackLanguage: AUTO_LANGUAGE_ID,
			explainRules: DEFAULT_EXPLAIN_RULES,
			translateRules: DEFAULT_TRANSLATE_RULES,
			translateModel: null,
			explainModel: null
		};
		/** 规则文本上限（避免把提示词撑爆）。 */
		const MAX_RULES_LENGTH = 4e3;
		/**
		* 把任意输入规整成合法设置（缺项补默认、非法值丢弃）。
		* 主客两边共用：客户端在提交前也用它做一次本地校验。
		*/
		function normalizeSettings(input) {
			const raw = input ?? {};
			const language = (value, fallback) => {
				const id = typeof value === "string" ? value : "";
				if (id === "auto") return id;
				return languageById(id) === void 0 ? fallback : id;
			};
			const rules = (value, fallback) => {
				if (typeof value !== "string") return fallback;
				const text = value.replace(/\r\n/g, "\n").trim();
				if (text === "") return fallback;
				return text.length > 4e3 ? text.slice(0, MAX_RULES_LENGTH) : text;
			};
			const seat = (value) => {
				if (value === null || value === void 0 || typeof value !== "object") return null;
				const candidate = value;
				const provider = typeof candidate.provider === "string" ? candidate.provider.trim() : "";
				const model = typeof candidate.model === "string" ? candidate.model.trim() : "";
				if (provider === "" || model === "") return null;
				const effort = typeof candidate.reasoningEffort === "string" ? candidate.reasoningEffort.trim() : "";
				return {
					provider,
					model,
					...effort === "" ? {} : { reasoningEffort: effort }
				};
			};
			return {
				targetLanguage: language(raw.targetLanguage, DEFAULT_SETTINGS.targetLanguage),
				fallbackLanguage: language(raw.fallbackLanguage, DEFAULT_SETTINGS.fallbackLanguage),
				explainRules: rules(raw.explainRules, DEFAULT_SETTINGS.explainRules),
				translateRules: rules(raw.translateRules, DEFAULT_SETTINGS.translateRules),
				translateModel: seat(raw.translateModel),
				explainModel: seat(raw.explainModel)
			};
		}
		//#endregion
		//#region src/client/api.ts
		/**
		* 浏览器半边对宿主插件路由的调用层：同源 fetch + SSE 帧解析，
		* 外加从官方 client 服务读取「当前会话/当前模型」的只读快照。
		*/
		/** 从字符串里取第一个非空字符串字段。 */
		function pickString(value) {
			return typeof value === "string" && value !== "" ? value : void 0;
		}
		/**
		* 读取当前会话的 cwd 与生效模型（与 DSH 输入框模型座位同源）。
		* 任何一步缺席都安静降级——宿主会回落到部署默认模型。
		* @param ctx - 客户端 Cordis 上下文。
		*/
		function readCurrentContext(ctx) {
			const result = {};
			try {
				const snapshot = (ctx.get?.("sessions"))?.list?.getSnapshot?.();
				const current = pickString(snapshot?.current);
				if (current === void 0) return result;
				result.sessionId = current;
				result.cwd = pickString(snapshot?.byId?.[current]?.cwd);
				const selection = ctx.get?.("modelDirectories")?.directoryFor?.(current)?.store?.getSnapshot?.()?.current;
				result.provider = pickString(selection?.provider);
				result.model = pickString(selection?.model);
			} catch {}
			return result;
		}
		/** 界面语言：与宿主 html lang / 浏览器语言一致。 */
		function detectLocale() {
			try {
				const lang = String(document?.documentElement?.lang ?? "");
				if (lang.toLowerCase().startsWith("zh")) return "zh";
				if (lang !== "") return "en";
				return String(navigator?.language ?? "zh").toLowerCase().startsWith("zh") ? "zh" : "en";
			} catch {
				return "zh";
			}
		}
		/**
		* 发起一轮划词翻译/解释。
		* @param action - 菜单动作。
		* @param text - 选中文本。
		* @param ctx - 客户端上下文（读取当前会话）。
		* @param context - 选中文本所在的上下文段落（页内路径取块级元素文本；没有就传空串）。
		* @returns abort：中止本次流（宿主侧仍会跑完，除非另行调用 stop）。
		*/
		function startRun(action, text, ctx, context, handlers) {
			const controller = new AbortController();
			let sessionId;
			const session = readCurrentContext(ctx);
			const trimmed = typeof context === "string" ? context.trim() : "";
			const request = {
				action,
				text,
				locale: detectLocale(),
				...trimmed === "" ? {} : { context: trimmed.slice(0, MAX_CONTEXT_LENGTH) },
				...session.cwd === void 0 ? {} : { cwd: session.cwd },
				...session.provider === void 0 ? {} : { provider: session.provider },
				...session.model === void 0 ? {} : { model: session.model }
			};
			(async () => {
				try {
					const response = await fetch(`${API_PREFIX}/run`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(request),
						signal: controller.signal
					});
					if (!response.ok) {
						const detail = await response.text().catch(() => "");
						handlers.onError(detail === "" ? `HTTP ${response.status}` : detail);
						return;
					}
					if (response.body === null) {
						handlers.onError("response body is not streamable");
						return;
					}
					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let buffer = "";
					for (;;) {
						const { value, done } = await reader.read();
						if (done === true) break;
						buffer += decoder.decode(value, { stream: true });
						let boundary = buffer.indexOf("\n\n");
						while (boundary !== -1) {
							const frame = buffer.slice(0, boundary);
							buffer = buffer.slice(boundary + 2);
							const payload = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
							const event = payload === "" ? void 0 : parseRunEvent(payload);
							if (event?.type === "session") {
								sessionId = event.sessionId;
								handlers.onSession?.(event.sessionId);
							} else if (event?.type === "delta") handlers.onDelta(event.text);
							else if (event?.type === "done") {
								sessionId = event.sessionId;
								handlers.onDone(event.text, event.sessionId);
							} else if (event?.type === "error") handlers.onError(event.message);
							boundary = buffer.indexOf("\n\n");
						}
					}
				} catch (error) {
					if (controller.signal.aborted) return;
					handlers.onError(error instanceof Error ? error.message : String(error));
				}
			})();
			return {
				abort: () => controller.abort(),
				sessionId: () => sessionId
			};
		}
		/** 请求宿主停止某条会话上正在跑的一轮（与官方 Stop 走同一条 agent.cancel）。 */
		async function stopRun(sessionId) {
			if (sessionId === void 0) return;
			try {
				await fetch(`${API_PREFIX}/stop`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId })
				});
			} catch {}
		}
		//#endregion
		//#region src/client/overlay.tsx
		/**
		* 划词菜单 + 悬浮窗（注册进 shell.overlay 的那一个 React 组件）。
		*
		* 交互：
		* - 页面里选中文字（拖选 / 双击 / 键盘扩选）→ 以选区右下角为锚点，在锚点
		*   第四象限（右下）弹出菜单，两项：「DeepSeek Harness 解释」「…翻译」。
		* - 点击菜单项 → 打开悬浮窗（默认屏幕右下角，可拖动、可八向缩放，可收起为
		*   悬浮球，可关闭），窗内流式渲染 Harness agent 的回答。
		* - 回答用官方 Markdown 原语渲染（与 DSH 对话里的排版一致）。
		*/
		/** 是否是 React 能渲染的组件（函数组件 / memo / forwardRef / class）。 */
		function isComponent(value) {
			if (typeof value === "function") return true;
			if (typeof value === "object" && value !== null) {
				const candidate = value;
				return typeof candidate.$$typeof === "symbol" || typeof candidate.render === "function";
			}
			return false;
		}
		/** 载入官方原语；模块表缺席时返回空对象而不是抛错。 */
		function loadPrimitives() {
			try {
				if (typeof require !== "function") return {};
				return require("@deepseek-ai/dsh-client-ui-primitives") ?? {};
			} catch {
				return {};
			}
		}
		const primitives = loadPrimitives();
		/** Markdown 渲染的界面文案（官方原语用它给代码块加复制按钮）。 */
		function markdownLabels(locale) {
			return locale === "zh" ? {
				code: {
					copyLabel: "复制",
					copiedLabel: "已复制"
				},
				footnotes: "脚注"
			} : {
				code: {
					copyLabel: "Copy",
					copiedLabel: "Copied"
				},
				footnotes: "Footnotes"
			};
		}
		/** 界面文案。 */
		const COPY$1 = {
			zh: {
				explain: "DeepSeek Harness 解释",
				translate: "DeepSeek Harness 翻译",
				panelExplain: "解释",
				panelTranslate: "翻译",
				expand: "展开原文",
				collapse: "收起原文",
				running: "Harness agent 生成中…",
				done: "完成",
				failed: "失败",
				copy: "复制",
				copied: "已复制",
				close: "关闭",
				stop: "停止",
				empty: "（没有文本输出）"
			},
			en: {
				explain: "Explain with DeepSeek Harness",
				translate: "Translate with DeepSeek Harness",
				panelExplain: "Explain",
				panelTranslate: "Translate",
				expand: "Show full source",
				collapse: "Collapse source",
				running: "Harness agent is working…",
				done: "Done",
				failed: "Failed",
				copy: "Copy",
				copied: "Copied",
				close: "Close",
				stop: "Stop",
				empty: "(no text output)"
			}
		};
		const PANEL_W = 400;
		const PANEL_H = 480;
		const PANEL_MIN_W = 280;
		const PANEL_MIN_H = 180;
		const MARGIN = 20;
		const MENU_W = 232;
		const MENU_H = 96;
		const LAYOUT_KEY = "dsh.selection-tools.layout";
		const viewport = () => ({
			w: typeof window === "undefined" ? 1280 : window.innerWidth,
			h: typeof window === "undefined" ? 800 : window.innerHeight
		});
		function clamp(value, min, max) {
			return Math.min(Math.max(value, min), Math.max(min, max));
		}
		/** 默认几何：悬浮窗停在屏幕右下角（悬浮球已移除）。 */
		function defaultLayout() {
			const { w, h } = viewport();
			return { panel: {
				x: Math.max(MARGIN, w - PANEL_W - MARGIN),
				y: Math.max(MARGIN, h - PANEL_H - MARGIN),
				w: PANEL_W,
				h: PANEL_H
			} };
		}
		/** 把几何夹回视口内（窗口缩放后仍然可见）。 */
		function clampLayout(layout) {
			const { w, h } = viewport();
			const panelW = clamp(layout.panel.w, PANEL_MIN_W, Math.max(PANEL_MIN_W, w - 40));
			const panelH = clamp(layout.panel.h, PANEL_MIN_H, Math.max(PANEL_MIN_H, h - 40));
			return { panel: {
				w: panelW,
				h: panelH,
				x: clamp(layout.panel.x, 0, w - panelW),
				y: clamp(layout.panel.y, 0, h - panelH)
			} };
		}
		function loadLayout() {
			try {
				const raw = window.localStorage.getItem(LAYOUT_KEY);
				if (raw === null) return defaultLayout();
				const parsed = JSON.parse(raw);
				return clampLayout({ panel: {
					...defaultLayout().panel,
					...parsed.panel ?? {}
				} });
			} catch {
				return defaultLayout();
			}
		}
		function saveLayout(layout) {
			try {
				window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
			} catch {}
		}
		/** 选区矩形：优先整段选区的包围盒（即「文字右下角」），退化时取最后一行的矩形。 */
		function selectionRect(range) {
			const box = range.getBoundingClientRect();
			if (box.width > 0 || box.height > 0) return {
				right: box.right,
				bottom: box.bottom
			};
			const rects = range.getClientRects();
			const last = rects.length > 0 ? rects[rects.length - 1] : void 0;
			return last === void 0 ? null : {
				right: last.right,
				bottom: last.bottom
			};
		}
		/** 输入类元素：在这些地方划词不弹菜单（避免和编辑器/输入框打架）。 */
		function isEditableTarget(node) {
			let element = node instanceof Element ? node : node?.parentElement ?? null;
			while (element !== null) {
				const tag = element.tagName.toLowerCase();
				if (tag === "input" || tag === "textarea" || tag === "select") return true;
				if (element.isContentEditable) return true;
				element = element.parentElement;
			}
			return false;
		}
		/**
		* 页内划词的"上下文"：选区所在的块级元素文本。
		*
		* 与系统级取词（伴生进程用 UIA 读段落）对齐：解释/翻译时一起交给 agent，
		* 让回答落在语境里；块级元素抓不到或与选区等价时返回空串。
		*/
		function contextForRange(range, selected) {
			try {
				const node = range.commonAncestorContainer;
				const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
				if (element === null) return "";
				const text = ((element.closest("p, li, td, th, pre, blockquote, dd, dt, figcaption, article, section") ?? element).textContent ?? "").replace(/\s+/gu, " ").trim();
				const needle = selected.trim();
				if (text === "" || needle === "" || text === needle || !text.includes(needle)) return "";
				return text.slice(0, MAX_CONTEXT_LENGTH);
			} catch {
				return "";
			}
		}
		/** 内置图标兜底（官方原语缺席时使用）。 */
		function fallbackIcon(path, size) {
			return (0, react.createElement)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.4,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true
			}, (0, react.createElement)("path", { d: path }));
		}
		const FALLBACK_PATHS = {
			sparkle: "M8 2.2 9.3 6 13 7.3 9.3 8.6 8 12.4 6.7 8.6 3 7.3 6.7 6z",
			globe: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM2.6 8h10.8M8 2.2c1.6 1.6 2.4 3.6 2.4 5.8S9.6 12.2 8 13.8C6.4 12.2 5.6 10.2 5.6 8S6.4 3.8 8 2.2z",
			copy: "M6 2.8h5.2a1 1 0 0 1 1 1V9M4.8 5.2h5.2a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4.8a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z",
			close: "M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6",
			chevronDown: "M4 6.4 8 10.2l4-3.8",
			stop: "M5 5h6v6H5z"
		};
		function icon(name, size = 16) {
			let official;
			switch (name) {
				case "sparkle":
					official = primitives.IconSparkle16;
					break;
				case "globe":
					official = primitives.IconGlobeOutline14;
					break;
				case "copy":
					official = primitives.IconCopyOutline16;
					break;
				case "close":
					official = primitives.IconCloseOutline16;
					break;
				case "chevronDown":
					official = primitives.IconChevronDownOutline14;
					break;
				case "stop": official = primitives.IconStopFill16;
			}
			if (isComponent(official)) return (0, react.createElement)(official, { size });
			return fallbackIcon(FALLBACK_PATHS[name], size);
		}
		/** 复制文本：优先官方剪贴板工具，其次 navigator.clipboard。 */
		async function copyText(text) {
			if (typeof primitives.writeClipboard === "function") {
				await primitives.writeClipboard(text);
				return;
			}
			await navigator.clipboard.writeText(text);
		}
		/** 渲染 Markdown 回答：官方 MarkdownText 缺席时退化为纯文本。 */
		function renderMarkdown(text, streaming, locale) {
			if (isComponent(primitives.MarkdownText)) return (0, react.createElement)(primitives.MarkdownText, {
				text,
				streaming,
				labels: markdownLabels(locale)
			});
			return (0, react.createElement)("pre", { className: "dst-plain" }, text);
		}
		/**
		* 划词菜单 + 悬浮窗。整个插件只有这一个 React 组件，注册进 shell.overlay。
		* @param props.ctx - 客户端 Cordis 上下文。
		*/
		function Overlay(props) {
			const { ctx } = props;
			const locale = (0, react.useMemo)(() => detectLocale(), []);
			const copy = COPY$1[locale];
			/** 系统级划词是否正在接管（接管时页内菜单让位，避免同一处弹两个菜单）。 */
			const systemWide = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				let cancelled = false;
				const probe = () => {
					fetch("/api/dsh-selection-tools/system/status").then((response) => response.ok ? response.json() : null).then((payload) => {
						if (!cancelled) systemWide.current = payload?.companion?.state === "running";
					}).catch(() => {
						if (!cancelled) systemWide.current = false;
					});
				};
				probe();
				const timer = window.setInterval(probe, 3e4);
				return () => {
					cancelled = true;
					window.clearInterval(timer);
				};
			}, []);
			const [menu, setMenu] = (0, react.useState)(null);
			const [panel, setPanel] = (0, react.useState)(null);
			const [binding, setBinding] = (0, react.useState)(() => typeof window === "undefined" ? defaultLayout() : loadLayout());
			const [copied, setCopied] = (0, react.useState)(false);
			const [expanded, setExpanded] = (0, react.useState)(false);
			const rootRef = (0, react.useRef)(null);
			const dragRef = (0, react.useRef)(null);
			const runRef = (0, react.useRef)(null);
			const layoutRef = (0, react.useRef)(binding);
			layoutRef.current = { panel: layoutRef.current.panel };
			/** 打开悬浮窗并立刻发起一轮。 */
			const openPanel = (0, react.useCallback)((action, text, context = "") => {
				setMenu(null);
				setCopied(false);
				setExpanded(false);
				runRef.current?.abort();
				const geometry = clampLayout(layoutRef.current);
				layoutRef.current = geometry;
				setPanel({
					x: geometry.panel.x,
					y: geometry.panel.y,
					w: geometry.panel.w,
					h: geometry.panel.h,
					action,
					source: text,
					status: "running",
					text: "",
					error: ""
				});
				runRef.current = startRun(action, text, ctx, context, {
					onSession: (sessionId) => setPanel((current) => current === null ? current : {
						...current,
						sessionId
					}),
					onDelta: (chunk) => setPanel((current) => current === null ? current : {
						...current,
						text: current.text + chunk
					}),
					onDone: (final, sessionId) => setPanel((current) => current === null ? current : {
						...current,
						status: "done",
						sessionId,
						text: final === "" ? current.text : final
					}),
					onError: (message) => setPanel((current) => current === null ? current : {
						...current,
						status: "error",
						error: message
					})
				});
			}, [ctx]);
			(0, react.useEffect)(() => {
				const insideOwnUi = (node) => node !== null && rootRef.current !== null && rootRef.current.contains(node);
				const dismiss = (event) => {
					if (insideOwnUi(event.target)) return;
					setMenu(null);
				};
				const inspectSelection = (event) => {
					const target = event.target;
					if (insideOwnUi(target) || isEditableTarget(target)) return;
					if (systemWide.current) return;
					window.setTimeout(() => {
						const selection = window.getSelection();
						if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
							setMenu(null);
							return;
						}
						const text = selection.toString().trim();
						if (text === "") {
							setMenu(null);
							return;
						}
						const range = selection.getRangeAt(0);
						if (insideOwnUi(range.commonAncestorContainer)) {
							setMenu(null);
							return;
						}
						const rect = selectionRect(range);
						if (rect === null) {
							setMenu(null);
							return;
						}
						setMenu({
							anchorX: rect.right,
							anchorY: rect.bottom,
							text: text.slice(0, MAX_SELECTION_LENGTH),
							context: contextForRange(range, text)
						});
					}, 0);
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") setMenu(null);
				};
				const onViewportChange = () => setMenu(null);
				document.addEventListener("pointerdown", dismiss, true);
				document.addEventListener("mouseup", inspectSelection, true);
				document.addEventListener("dblclick", inspectSelection, true);
				document.addEventListener("keydown", onKeyDown, true);
				window.addEventListener("resize", onViewportChange);
				window.addEventListener("scroll", onViewportChange, true);
				return () => {
					document.removeEventListener("pointerdown", dismiss, true);
					document.removeEventListener("mouseup", inspectSelection, true);
					document.removeEventListener("dblclick", inspectSelection, true);
					document.removeEventListener("keydown", onKeyDown, true);
					window.removeEventListener("resize", onViewportChange);
					window.removeEventListener("scroll", onViewportChange, true);
				};
			}, []);
			const persistPanel = (0, react.useCallback)((next) => {
				layoutRef.current = { panel: {
					x: next.x,
					y: next.y,
					w: next.w,
					h: next.h
				} };
				saveLayout(layoutRef.current);
			}, []);
			const beginMove = (event) => {
				if (panel === null || event.button !== 0) return;
				event.preventDefault();
				event.currentTarget.setPointerCapture(event.pointerId);
				dragRef.current = {
					kind: "move",
					edge: "",
					pointerX: event.clientX,
					pointerY: event.clientY,
					x: panel.x,
					y: panel.y,
					w: panel.w,
					h: panel.h
				};
			};
			const beginResize = (edge) => (event) => {
				if (panel === null || event.button !== 0) return;
				event.preventDefault();
				event.stopPropagation();
				event.currentTarget.setPointerCapture(event.pointerId);
				dragRef.current = {
					kind: "resize",
					edge,
					pointerX: event.clientX,
					pointerY: event.clientY,
					x: panel.x,
					y: panel.y,
					w: panel.w,
					h: panel.h
				};
			};
			const onDragMove = (event) => {
				const drag = dragRef.current;
				if (drag === null) return;
				const dx = event.clientX - drag.pointerX;
				const dy = event.clientY - drag.pointerY;
				const box = viewport();
				if (drag.kind === "move") {
					const x = clamp(drag.x + dx, 0, box.w - drag.w);
					const y = clamp(drag.y + dy, 0, box.h - drag.h);
					setPanel((current) => current === null ? current : {
						...current,
						x,
						y
					});
					return;
				}
				let { x, y, w, h } = drag;
				if (drag.edge.includes("e")) w = clamp(drag.w + dx, PANEL_MIN_W, box.w - drag.x);
				if (drag.edge.includes("s")) h = clamp(drag.h + dy, PANEL_MIN_H, box.h - drag.y);
				if (drag.edge.includes("w")) {
					const nextW = clamp(drag.w - dx, PANEL_MIN_W, drag.x + drag.w);
					x = drag.x + (drag.w - nextW);
					w = nextW;
				}
				if (drag.edge.includes("n")) {
					const nextH = clamp(drag.h - dy, PANEL_MIN_H, drag.y + drag.h);
					y = drag.y + (drag.h - nextH);
					h = nextH;
				}
				setPanel((current) => current === null ? current : {
					...current,
					x,
					y,
					w,
					h
				});
			};
			const onDragEnd = () => {
				if (dragRef.current === null) return;
				dragRef.current = null;
				setPanel((current) => {
					if (current !== null) persistPanel(current);
					return current;
				});
			};
			(0, react.useEffect)(() => {
				const onResize = () => {
					const next = clampLayout(layoutRef.current);
					layoutRef.current = next;
					setBinding((current) => ({
						...current,
						panel: next.panel
					}));
					setPanel((current) => current === null ? current : {
						...current,
						x: next.panel.x,
						y: next.panel.y,
						w: next.panel.w,
						h: next.panel.h
					});
				};
				window.addEventListener("resize", onResize);
				return () => window.removeEventListener("resize", onResize);
			}, []);
			const closePanel = () => {
				runRef.current?.abort();
				runRef.current = null;
				setPanel(null);
			};
			const onCopy = () => {
				if (panel === null) return;
				copyText(panel.text).then(() => {
					setCopied(true);
					window.setTimeout(() => setCopied(false), 1600);
				}, () => void 0);
			};
			const onStop = () => {
				stopRun(panel?.sessionId);
				runRef.current?.abort();
				runRef.current = null;
				setPanel((current) => current === null ? current : {
					...current,
					status: "done"
				});
			};
			let menuNode = null;
			if (menu !== null) {
				const box = viewport();
				const x = clamp(menu.anchorX + 8, 8, box.w - MENU_W - 8);
				const y = clamp(menu.anchorY + 8, 8, box.h - MENU_H - 8);
				const item = (action, label, iconName) => (0, react.createElement)("button", {
					type: "button",
					className: "dst-menu-item",
					role: "menuitem",
					onMouseDown: (event) => event.preventDefault(),
					onClick: () => openPanel(action, menu.text, menu.context)
				}, (0, react.createElement)("span", { className: "dst-menu-item-icon" }, icon(iconName, 16)), (0, react.createElement)("span", { className: "dst-menu-item-label" }, label));
				menuNode = (0, react.createElement)("div", {
					className: "dst-menu",
					style: {
						left: x,
						top: y,
						width: MENU_W
					},
					role: "menu"
				}, item("explain", copy.explain, "sparkle"), item("translate", copy.translate, "globe"));
			}
			const statusText = panel === null ? "" : panel.status === "running" ? copy.running : panel.status === "error" ? copy.failed : copy.done;
			const headerButton = (options) => (0, react.createElement)("button", {
				type: "button",
				className: "dst-icon-btn",
				title: options.label,
				"aria-label": options.label,
				disabled: options.disabled === true,
				onPointerDown: (event) => event.stopPropagation(),
				onClick: options.onClick
			}, icon(options.iconName, 16));
			const panelNode = panel === null ? null : (0, react.createElement)("section", {
				className: "dst-panel",
				style: {
					left: panel.x,
					top: panel.y,
					width: panel.w,
					height: panel.h
				},
				role: "dialog",
				"aria-label": panel.action === "translate" ? copy.panelTranslate : copy.panelExplain
			}, (0, react.createElement)("header", {
				className: "dst-panel-header",
				onPointerDown: beginMove,
				onPointerMove: onDragMove,
				onPointerUp: onDragEnd,
				onPointerCancel: onDragEnd
			}, (0, react.createElement)("span", { className: "dst-menu-item-icon" }, icon(panel.action === "translate" ? "globe" : "sparkle", 16)), (0, react.createElement)("span", { className: "dst-panel-title" }, panel.action === "translate" ? copy.panelTranslate : copy.panelExplain), (0, react.createElement)("span", { className: "dst-panel-actions" }, headerButton({
				label: copied ? copy.copied : copy.copy,
				iconName: "copy",
				disabled: panel.text === "",
				onClick: onCopy
			}), headerButton({
				label: copy.close,
				iconName: "close",
				onClick: closePanel
			}))), (0, react.createElement)("div", { className: "dst-panel-body" }, (0, react.createElement)("div", {
				className: "dst-source",
				"data-expanded": expanded ? "true" : "false"
			}, panel.source, panel.source.length > 160 ? (0, react.createElement)("button", {
				type: "button",
				className: "dst-source-toggle",
				onClick: () => setExpanded((value) => !value)
			}, expanded ? copy.collapse : copy.expand) : null), (0, react.createElement)("div", { className: "dst-answer" }, panel.text === "" ? panel.status === "running" ? (0, react.createElement)("span", { className: "dst-caret" }) : (0, react.createElement)("span", { className: "dst-empty" }, copy.empty) : renderMarkdown(panel.text, panel.status === "running", locale))), (0, react.createElement)("footer", { className: "dst-panel-foot" }, (0, react.createElement)("span", {
				className: "dst-dot",
				"data-state": panel.status
			}), (0, react.createElement)("span", { className: panel.status === "error" ? "dst-error" : "" }, statusText), panel.status === "error" && panel.error !== "" ? (0, react.createElement)("span", { className: "dst-error" }, panel.error) : null, (0, react.createElement)("span", { className: "dst-foot-spacer" }), panel.status === "running" ? (0, react.createElement)("button", {
				type: "button",
				className: "dst-link",
				onClick: onStop
			}, copy.stop) : null), ...[
				"n",
				"s",
				"e",
				"w",
				"ne",
				"nw",
				"se",
				"sw"
			].map((edge) => (0, react.createElement)("div", {
				key: edge,
				className: "dst-resize dst-resize-" + edge,
				onPointerDown: beginResize(edge),
				onPointerMove: onDragMove,
				onPointerUp: onDragEnd,
				onPointerCancel: onDragEnd
			})));
			return (0, react.createElement)("div", {
				ref: rootRef,
				className: "dst-root"
			}, menuNode, panelNode);
		}
		//#endregion
		//#region src/client/settings.tsx
		/**
		* 设置页里的「划词工具」一页（settings.section）。
		*
		* 数据流：宿主半边持有设置文件（dsh-selection-tools.json）与 HTTP 路由，
		* 这里只用同源 fetch 读写——不依赖官方 settings 服务，插件在任何 profile 下都能用。
		*
		* 模型下拉的候选来自官方 \`ctx.modelDirectories\`（与输入框的模型座位同一份目录），
		* 目录读不到时退化成手填 provider / model。
		*/
		/** 文案。 */
		const COPY = {
			zh: {
				title: "划词工具",
				hint: "在任意应用里选中文字 → 菜单里点解释/翻译。这里的设置对所有划词生效，改完立即保存。",
				targetLabel: "默认翻译至",
				targetHint: "选「跟随原文自动」时保持老行为：中文译成英文，其它语言译成中文。",
				fallbackLabel: "反向目标语言",
				fallbackHint: "当选中文字已经是「默认翻译至」的语言时，改译成这个语言（选「自动」则取镜像：原文是中文就译英文，否则译中文）。",
				explainRulesLabel: "解释规则（交给模型的要求）",
				explainRulesHint: "这段文字会原样作为「要求」写进解释的提示词，一行一条。",
				translateRulesLabel: "翻译规则（交给模型的要求）",
				translateRulesHint: "这段文字会原样作为「要求」写进翻译的提示词，一行一条。",
				restore: "恢复默认",
				translateModelLabel: "翻译使用的模型",
				explainModelLabel: "解释使用的模型",
				modelHint: "「跟随当前会话」= 用你当前对话正在用的模型。",
				effortLabel: "推理等级",
				effortDefault: "适配器默认",
				followSession: "跟随当前会话",
				auto: "跟随原文自动（中 ↔ 英）",
				autoMirror: "自动（镜像）",
				manualHint: "暂时读不到模型目录，可直接填写 provider / model。",
				provider: "provider",
				model: "model",
				saved: "已保存",
				saving: "保存中…",
				failed: "保存失败",
				loading: "读取设置中…",
				loadFailed: "读取设置失败",
				retry: "重试"
			},
			en: {
				title: "Selection tools",
				hint: "Select text in any app, then pick Explain / Translate from the menu. Settings apply to every selection and save immediately.",
				targetLabel: "Translate into",
				targetHint: "\"Follow the source\" keeps the original behaviour: Chinese → English, anything else → Chinese.",
				fallbackLabel: "Fallback target",
				fallbackHint: "Used when the selection is already in the primary target language.",
				explainRulesLabel: "Explain rules (given to the model)",
				explainRulesHint: "Sent verbatim as the \"Requirements\" block of the explain prompt, one rule per line.",
				translateRulesLabel: "Translate rules (given to the model)",
				translateRulesHint: "Sent verbatim as the \"Requirements\" block of the translate prompt, one rule per line.",
				restore: "Restore default",
				translateModelLabel: "Model for translation",
				explainModelLabel: "Model for explanation",
				modelHint: "\"Follow the current session\" uses whatever model your conversation uses.",
				effortLabel: "Reasoning effort",
				effortDefault: "Adapter default",
				followSession: "Follow current session",
				auto: "Follow the source (zh ↔ en)",
				autoMirror: "Automatic (mirror)",
				manualHint: "The model catalog is not available yet — type provider / model directly.",
				provider: "provider",
				model: "model",
				saved: "Saved",
				saving: "Saving…",
				failed: "Save failed",
				loading: "Loading…",
				loadFailed: "Could not load settings",
				retry: "Retry"
			}
		};
		/** 语言下拉的选项（含"自动"）。 */
		function languageOptions(autoLabel) {
			return [{
				id: AUTO_LANGUAGE_ID,
				label: autoLabel
			}, ...LANGUAGES.map((item) => ({
				id: item.id,
				label: item.label + " (" + item.prompt + ")"
			}))];
		}
		/**
		* 读模型目录。
		*
		* 两个来源，按优先级用：
		* 1. 当前会话的模型座位目录（`modelDirectories.directoryFor(sessionId)`）——与输入框同一份，
		*    但**只有存在当前会话时才有**；
		* 2. 全局模型目录（`modelDirectories.catalog`）——设置页常常在"还没开会话"时被打开，
		*    这时只能用它（它是一次 host RPC，不依赖会话）。
		*/
		function useModelCatalog(ctx) {
			const [groups, setGroups] = (0, react.useState)([]);
			(0, react.useEffect)(() => {
				const directories = ctx.get?.("modelDirectories");
				if (directories === void 0 || directories === null) return void 0;
				let directory;
				try {
					const sessionId = ctx.get?.("sessions")?.list?.getSnapshot?.()?.current;
					directory = sessionId === void 0 ? void 0 : directories.directoryFor?.(sessionId);
				} catch {
					directory = void 0;
				}
				const catalog = directories.catalog;
				const read = () => {
					const fromDirectory = directory?.store?.getSnapshot?.();
					const fromCatalog = catalog?.store?.getSnapshot?.();
					const directoryGroups = Array.isArray(fromDirectory?.groups) ? fromDirectory.groups : [];
					const catalogGroups = Array.isArray(fromCatalog?.value?.groups) ? fromCatalog.value.groups : [];
					setGroups(directoryGroups.length > 0 ? directoryGroups : catalogGroups);
				};
				const stops = [];
				for (const store of [directory?.store, catalog?.store]) {
					if (typeof store?.subscribe !== "function") continue;
					const stop = store.subscribe(read);
					if (typeof stop === "function") stops.push(stop);
				}
				try {
					catalog?.load?.().catch?.(() => void 0);
				} catch {}
				read();
				return () => {
					for (const stop of stops) stop();
				};
			}, [ctx]);
			return {
				groups,
				ready: groups.length > 0
			};
		}
		/** 一个模型座位选择器（模型 + 推理等级）。 */
		function ModelSeatField(props) {
			const { label, hint, copy, seat, groups, catalogsReady, onChange } = props;
			const flat = (0, react.useMemo)(() => groups.flatMap((group) => (group.models ?? []).map((model) => ({
				key: group.id + "/" + model.id,
				provider: group.id,
				providerLabel: group.name ?? group.label ?? group.id,
				model
			}))), [groups]);
			const current = seat === null ? "" : seat.provider + "/" + seat.model;
			const efforts = (0, react.useMemo)(() => {
				if (seat === null) return [];
				return flat.find((item) => item.provider === seat.provider && item.model.id === seat.model)?.model.reasoning?.efforts ?? [];
			}, [flat, seat]);
			const pickModel = (value) => {
				if (value === "") {
					onChange(null);
					return;
				}
				const found = flat.find((item) => item.key === value);
				if (found === void 0) return;
				const defaultEffort = found.model.reasoning?.defaultEffort;
				onChange({
					provider: found.provider,
					model: found.model.id,
					...defaultEffort === void 0 ? {} : { reasoningEffort: defaultEffort }
				});
			};
			const rows = [];
			rows.push((0, react.createElement)("span", { className: "dst-set-label" }, label), catalogsReady ? (0, react.createElement)("select", {
				className: "dst-set-input",
				value: current,
				onChange: (event) => pickModel(String(event.target.value))
			}, [(0, react.createElement)("option", {
				key: "",
				value: ""
			}, copy.followSession), ...flat.map((item) => (0, react.createElement)("option", {
				key: item.key,
				value: item.key
			}, item.providerLabel + " · " + (item.model.name ?? item.model.id)))]) : (0, react.createElement)("div", { className: "dst-set-row" }, (0, react.createElement)("input", {
				className: "dst-set-input",
				placeholder: copy.provider,
				value: seat?.provider ?? "",
				onChange: (event) => onChange({
					provider: String(event.target.value),
					model: seat?.model ?? ""
				})
			}), (0, react.createElement)("input", {
				className: "dst-set-input",
				placeholder: copy.model,
				value: seat?.model ?? "",
				onChange: (event) => onChange({
					provider: seat?.provider ?? "",
					model: String(event.target.value)
				})
			})));
			if (catalogsReady && seat !== null && efforts.length > 0) rows.push((0, react.createElement)("div", { className: "dst-set-row" }, (0, react.createElement)("span", { className: "dst-set-sub" }, copy.effortLabel), (0, react.createElement)("select", {
				className: "dst-set-input",
				value: seat.reasoningEffort ?? "",
				onChange: (event) => {
					const effort = String(event.target.value);
					onChange({
						provider: seat.provider,
						model: seat.model,
						...effort === "" ? {} : { reasoningEffort: effort }
					});
				}
			}, [(0, react.createElement)("option", {
				key: "",
				value: ""
			}, copy.effortDefault), ...efforts.map((effort) => (0, react.createElement)("option", {
				key: effort.id,
				value: effort.id
			}, effort.name ?? effort.id))])));
			rows.push((0, react.createElement)("span", { className: "dst-set-hint" }, catalogsReady ? hint : copy.manualHint));
			return (0, react.createElement)("div", { className: "dst-set-field" }, rows);
		}
		/**
		* 「划词工具」设置页。
		* @param props.ctx - 客户端 Cordis 上下文。
		*/
		function SettingsSection(props) {
			const { ctx } = props;
			const locale = detectLocale();
			const copy = COPY[locale];
			const [settings, setSettings] = (0, react.useState)(null);
			const [status, setStatus] = (0, react.useState)("loading");
			const [error, setError] = (0, react.useState)("");
			const timer = (0, react.useRef)(null);
			const { groups, ready: catalogsReady } = useModelCatalog(ctx);
			const load = (0, react.useCallback)(() => {
				setStatus("loading");
				fetch(API_PREFIX + "/settings").then((response) => response.ok ? response.json() : Promise.reject(/* @__PURE__ */ new Error("HTTP " + response.status))).then((payload) => {
					setSettings(normalizeSettings(payload.settings));
					setStatus("ready");
					setError("");
				}).catch((cause) => {
					setStatus("error");
					setError(cause instanceof Error ? cause.message : String(cause));
				});
			}, []);
			(0, react.useEffect)(() => {
				load();
				return () => {
					if (timer.current !== null) window.clearTimeout(timer.current);
				};
			}, [load]);
			/** 改一项 → 立刻本地生效 + 防抖落盘。 */
			const update = (0, react.useCallback)((patch) => {
				setSettings((current) => {
					if (current === null) return current;
					const next = normalizeSettings({
						...current,
						...patch
					});
					setStatus("saving");
					if (timer.current !== null) window.clearTimeout(timer.current);
					timer.current = window.setTimeout(() => {
						timer.current = null;
						fetch(API_PREFIX + "/settings", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify(next)
						}).then((response) => response.ok ? response.json() : Promise.reject(/* @__PURE__ */ new Error("HTTP " + response.status))).then((payload) => {
							setSettings(normalizeSettings(payload.settings));
							setStatus("saved");
							setError("");
						}).catch((cause) => {
							setStatus("error");
							setError(cause instanceof Error ? cause.message : String(cause));
						});
					}, 220);
					return next;
				});
			}, []);
			if (settings === null) return (0, react.createElement)("div", { className: "dst-set-section" }, (0, react.createElement)("h2", { className: "dst-set-title" }, copy.title), (0, react.createElement)("div", { className: "dst-set-status" }, (0, react.createElement)("span", { className: status === "error" ? "dst-set-error" : "" }, status === "error" ? copy.loadFailed + "：" + error : copy.loading), status === "error" ? (0, react.createElement)("button", {
				type: "button",
				className: "dst-set-link",
				onClick: load
			}, copy.retry) : null));
			const statusText = status === "saving" ? copy.saving : status === "saved" ? copy.saved : status === "error" ? copy.failed + "：" + error : "";
			const languageField = (label, hint, value, autoLabel, key) => (0, react.createElement)("div", {
				className: "dst-set-field",
				key
			}, (0, react.createElement)("span", { className: "dst-set-label" }, label), (0, react.createElement)("select", {
				className: "dst-set-input",
				value,
				onChange: (event) => update({ [key]: String(event.target.value) })
			}, languageOptions(autoLabel).map((option) => (0, react.createElement)("option", {
				key: option.id,
				value: option.id
			}, option.label))), (0, react.createElement)("span", { className: "dst-set-hint" }, hint));
			const rulesField = (key, label, hint, value, fallback) => (0, react.createElement)("div", {
				className: "dst-set-field",
				key
			}, (0, react.createElement)("div", { className: "dst-set-labelrow" }, (0, react.createElement)("span", { className: "dst-set-label" }, label), (0, react.createElement)("button", {
				type: "button",
				className: "dst-set-link",
				onClick: () => update({ [key]: fallback })
			}, copy.restore)), (0, react.createElement)("textarea", {
				className: "dst-set-textarea",
				rows: 6,
				spellCheck: false,
				value,
				onChange: (event) => update({ [key]: String(event.target.value) })
			}), (0, react.createElement)("span", { className: "dst-set-hint" }, hint));
			return (0, react.createElement)("div", { className: "dst-set-section" }, (0, react.createElement)("h2", { className: "dst-set-title" }, copy.title), (0, react.createElement)("p", { className: "dst-set-hint dst-set-intro" }, copy.hint), languageField(copy.targetLabel, copy.targetHint, settings.targetLanguage, copy.auto, "targetLanguage"), languageField(copy.fallbackLabel, copy.fallbackHint, settings.fallbackLanguage, copy.autoMirror, "fallbackLanguage"), (0, react.createElement)(ModelSeatField, {
				key: "translate-model",
				label: copy.translateModelLabel,
				hint: copy.modelHint,
				copy,
				seat: settings.translateModel,
				groups,
				catalogsReady,
				onChange: (seat) => update({ translateModel: seat })
			}), (0, react.createElement)(ModelSeatField, {
				key: "explain-model",
				label: copy.explainModelLabel,
				hint: copy.modelHint,
				copy,
				seat: settings.explainModel,
				groups,
				catalogsReady,
				onChange: (seat) => update({ explainModel: seat })
			}), rulesField("explainRules", copy.explainRulesLabel, copy.explainRulesHint, settings.explainRules, DEFAULT_EXPLAIN_RULES), rulesField("translateRules", copy.translateRulesLabel, copy.translateRulesHint, settings.translateRules, DEFAULT_TRANSLATE_RULES), (0, react.createElement)("div", { className: "dst-set-status" }, (0, react.createElement)("span", { className: status === "error" ? "dst-set-error" : "" }, statusText)));
		}
		//#endregion
		//#region src/client/styles.ts
		/**
		* 插件自有 CSS：结构与配色沿用 DSH 官方菜单/卡片的做法（specific-menu +
		* elevation-prominent + 官方主题令牌），因此与宿主外观一致、深浅色自动跟随。
		*
		* 注入方式照抄官方 client 包：带 data-plugin / data-plugin-css 的 <style>，
		* HMR 驱动按 tag id 回收，插件卸载不残留。
		*/
		/** 样式标签身份：官方 HMR 按它回收，卸载不留残余。 */
		const STYLE_TAG_ID = "dsh-selection-tools/client.css";
		const CSS = "\n/* dsh-selection-tools —— 划词菜单 + 悬浮窗样式。\n *\n * 颜色/圆角/阴影全部沿用 DSH 自己的主题令牌（--dsw-*），因此深色/浅色主题\n * 自动跟随；令牌缺席时回落到同色系兜底值，保证在旧版宿主里也能看。\n * 结构照抄官方菜单/卡片配方：menu = specific-menu + elevation-prominent + 20px 圆角，\n * item = 40px 高 / 10px 圆角 / hover 用 interactive-bg-hover。\n */\n\n.dst-root {\n  font-family: inherit;\n  font-size: 14px;\n  line-height: 22px;\n  color: var(--dsw-alias-label-primary, #1a1a1a);\n}\n\n/* ---------- 划词菜单（锚点第四象限） ---------- */\n\n.dst-menu {\n  position: fixed;\n  z-index: 2400;\n  display: flex;\n  flex-direction: column;\n  min-width: 208px;\n  padding: 4px;\n  box-sizing: border-box;\n  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #ffffff));\n  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));\n  box-shadow: var(--dsw-elevation-prominent, 0 3px 8px rgba(0, 0, 0, 0.06), 0 0 20px rgba(0, 0, 0, 0.06));\n  border-radius: 20px;\n  animation: dst-fade-in 0.12s ease-out;\n}\n\n.dst-menu-item {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  width: 100%;\n  min-height: 40px;\n  padding: 8px 10px;\n  box-sizing: border-box;\n  border: 0;\n  border-radius: 10px;\n  background: transparent;\n  color: var(--dsw-alias-label-primary, #1a1a1a);\n  font: inherit;\n  text-align: left;\n  cursor: pointer;\n}\n\n.dst-menu-item:hover,\n.dst-menu-item:focus-visible {\n  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06));\n  outline: none;\n}\n\n.dst-menu-item-icon {\n  display: inline-flex;\n  flex: none;\n  width: 16px;\n  height: 16px;\n  color: var(--dsw-alias-label-tertiary, #8a8f99);\n}\n\n.dst-menu-item-label {\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n/* ---------- 悬浮窗 ---------- */\n\n.dst-panel {\n  position: fixed;\n  z-index: 2390;\n  display: flex;\n  flex-direction: column;\n  min-width: 280px;\n  min-height: 180px;\n  box-sizing: border-box;\n  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #ffffff));\n  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));\n  box-shadow: var(--dsw-elevation-prominent, 0 3px 8px rgba(0, 0, 0, 0.06), 0 0 20px rgba(0, 0, 0, 0.06));\n  border-radius: 16px;\n  overflow: hidden;\n  animation: dst-fade-in 0.12s ease-out;\n}\n\n.dst-panel-header {\n  display: flex;\n  flex: none;\n  align-items: center;\n  gap: 8px;\n  height: 44px;\n  padding: 0 6px 0 12px;\n  box-sizing: border-box;\n  cursor: grab;\n  user-select: none;\n  touch-action: none;\n}\n\n.dst-panel-header:active {\n  cursor: grabbing;\n}\n\n.dst-panel-title {\n  flex: 1;\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  font-size: 14px;\n  font-weight: 500;\n  color: var(--dsw-alias-label-primary, #1a1a1a);\n}\n\n.dst-panel-actions {\n  display: flex;\n  flex: none;\n  align-items: center;\n  gap: 2px;\n}\n\n.dst-icon-btn {\n  display: inline-flex;\n  flex: none;\n  align-items: center;\n  justify-content: center;\n  width: 28px;\n  height: 28px;\n  border: 0;\n  border-radius: 999px;\n  background: transparent;\n  color: var(--dsw-alias-label-tertiary, #8a8f99);\n  cursor: pointer;\n}\n\n.dst-icon-btn:hover {\n  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06));\n  color: var(--dsw-alias-label-secondary, #5b6068);\n}\n\n.dst-icon-btn[disabled] {\n  opacity: 0.4;\n  cursor: default;\n}\n\n.dst-panel-body {\n  flex: 1;\n  min-height: 0;\n  overflow: auto;\n  padding: 0 14px 14px;\n  box-sizing: border-box;\n  scrollbar-width: thin;\n  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2, rgba(0, 0, 0, 0.18));\n  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2, rgba(0, 0, 0, 0.3));\n}\n\n.dst-source {\n  margin: 0 0 10px;\n  padding: 8px 10px;\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.03));\n  color: var(--dsw-alias-label-secondary, #5b6068);\n  font-size: 12px;\n  line-height: 18px;\n  white-space: pre-wrap;\n  word-break: break-word;\n  max-height: 84px;\n  overflow: auto;\n}\n\n.dst-source[data-expanded='true'] {\n  max-height: 240px;\n}\n\n.dst-source-toggle {\n  margin-top: 4px;\n  padding: 0;\n  border: 0;\n  background: transparent;\n  color: var(--dsw-alias-state-business-primary, #4d6bfe);\n  font: inherit;\n  font-size: 12px;\n  cursor: pointer;\n}\n\n.dst-answer {\n  min-height: 22px;\n  word-break: break-word;\n}\n\n.dst-plain {\n  margin: 0;\n  font-family: inherit;\n  font-size: 14px;\n  line-height: 22px;\n  white-space: pre-wrap;\n  word-break: break-word;\n}\n\n.dst-caret {\n  display: inline-block;\n  width: 6px;\n  height: 15px;\n  margin-left: 2px;\n  vertical-align: -2px;\n  border-radius: 2px;\n  background: var(--dsw-alias-label-tertiary, #8a8f99);\n  animation: dst-blink 1s steps(2, start) infinite;\n}\n\n.dst-panel-foot {\n  display: flex;\n  flex: none;\n  align-items: center;\n  gap: 8px;\n  padding: 8px 12px;\n  box-sizing: border-box;\n  border-top: 1px solid var(--dsw-alias-separator-primary, rgba(0, 0, 0, 0.06));\n  color: var(--dsw-alias-label-tertiary, #8a8f99);\n  font-size: 12px;\n  line-height: 18px;\n}\n\n.dst-foot-spacer {\n  flex: 1;\n}\n\n.dst-link {\n  padding: 0;\n  border: 0;\n  background: transparent;\n  color: var(--dsw-alias-state-business-primary, #4d6bfe);\n  font: inherit;\n  font-size: 12px;\n  cursor: pointer;\n}\n\n.dst-error {\n  color: var(--dsw-alias-state-error-primary, #d92d20);\n}\n\n.dst-dot {\n  display: inline-block;\n  flex: none;\n  width: 6px;\n  height: 6px;\n  border-radius: 999px;\n  background: var(--dsw-alias-label-caption, #b6bac2);\n}\n\n.dst-dot[data-state='running'] {\n  background: var(--dsw-alias-state-business-primary, #4d6bfe);\n  animation: dst-pulse 1.2s ease-in-out infinite;\n}\n\n.dst-dot[data-state='done'] {\n  background: var(--dsw-alias-state-success-primary, #12b76a);\n}\n\n.dst-dot[data-state='error'] {\n  background: var(--dsw-alias-state-error-primary, #d92d20);\n}\n\n/* ---------- 尺寸手柄 ---------- */\n\n.dst-resize {\n  position: absolute;\n  z-index: 2;\n  touch-action: none;\n}\n\n.dst-resize-e {\n  top: 8px;\n  right: 0;\n  bottom: 8px;\n  width: 6px;\n  cursor: ew-resize;\n}\n\n.dst-resize-w {\n  top: 8px;\n  bottom: 8px;\n  left: 0;\n  width: 6px;\n  cursor: ew-resize;\n}\n\n.dst-resize-s {\n  right: 8px;\n  bottom: 0;\n  left: 8px;\n  height: 6px;\n  cursor: ns-resize;\n}\n\n.dst-resize-n {\n  top: 0;\n  right: 8px;\n  left: 8px;\n  height: 6px;\n  cursor: ns-resize;\n}\n\n.dst-resize-se,\n.dst-resize-sw,\n.dst-resize-ne,\n.dst-resize-nw {\n  width: 14px;\n  height: 14px;\n}\n\n.dst-resize-se {\n  right: 0;\n  bottom: 0;\n  cursor: nwse-resize;\n}\n\n.dst-resize-sw {\n  bottom: 0;\n  left: 0;\n  cursor: nesw-resize;\n}\n\n.dst-resize-ne {\n  top: 0;\n  right: 0;\n  cursor: nesw-resize;\n}\n\n.dst-resize-nw {\n  top: 0;\n  left: 0;\n  cursor: nwse-resize;\n}\n\n@keyframes dst-fade-in {\n  from {\n    opacity: 0;\n    transform: translateY(2px);\n  }\n  to {\n    opacity: 1;\n    transform: none;\n  }\n}\n\n@keyframes dst-blink {\n  50% {\n    opacity: 0;\n  }\n}\n\n/* ---------- 设置页（settings.section） ---------- */\n\n.dst-set-section {\n  display: flex;\n  flex-direction: column;\n  gap: 18px;\n  max-width: 640px;\n}\n\n.dst-set-title {\n  margin: 0;\n  font-size: 16px;\n  font-weight: 600;\n  color: var(--dsw-alias-label-primary, #1a1a1a);\n}\n\n.dst-set-intro {\n  margin: 0;\n}\n\n.dst-set-field {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n}\n\n.dst-set-labelrow {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 8px;\n}\n\n.dst-set-label {\n  font-size: 13px;\n  font-weight: 500;\n  color: var(--dsw-alias-label-primary, #1a1a1a);\n}\n\n.dst-set-sub {\n  flex: none;\n  font-size: 12px;\n  color: var(--dsw-alias-label-tertiary, #8a8f99);\n}\n\n.dst-set-hint {\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-tertiary, #8a8f99);\n}\n\n.dst-set-row {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n}\n\n.dst-set-input {\n  width: 100%;\n  height: 32px;\n  padding: 0 10px;\n  box-sizing: border-box;\n  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.12));\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.03));\n  color: var(--dsw-alias-label-primary, #1a1a1a);\n  font: inherit;\n  font-size: 13px;\n  outline: none;\n}\n\n.dst-set-input:focus {\n  border-color: var(--dsw-alias-state-business-primary, #4d6bfe);\n}\n\n.dst-set-textarea {\n  width: 100%;\n  padding: 8px 10px;\n  box-sizing: border-box;\n  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.12));\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.03));\n  color: var(--dsw-alias-label-primary, #1a1a1a);\n  font: inherit;\n  font-size: 13px;\n  line-height: 20px;\n  resize: vertical;\n  outline: none;\n}\n\n.dst-set-textarea:focus {\n  border-color: var(--dsw-alias-state-business-primary, #4d6bfe);\n}\n\n.dst-set-link {\n  padding: 0;\n  border: 0;\n  background: transparent;\n  color: var(--dsw-alias-state-business-primary, #4d6bfe);\n  font: inherit;\n  font-size: 12px;\n  cursor: pointer;\n}\n\n.dst-set-status {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  min-height: 18px;\n  font-size: 12px;\n  color: var(--dsw-alias-label-tertiary, #8a8f99);\n}\n\n.dst-set-error {\n  color: var(--dsw-alias-state-error-primary, #d92d20);\n}\n\n@keyframes dst-pulse {\n  50% {\n    opacity: 0.35;\n  }\n}\n";
		/** 注入一次插件样式（重复调用是空操作）。 */
		function ensureStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector(`style[data-plugin-css=${JSON.stringify("dsh-selection-tools/client.css")}]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-selection-tools";
			tag.dataset.pluginCss = STYLE_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region src/client/index.tsx
		/**
		* dsh-selection-tools —— 浏览器半边入口。
		*
		* 两处注册：
		* - \`shell.overlay\`：页内划词菜单 + 回答窗口（系统级伴生进程在跑时它让位）；
		* - \`settings.section\`：设置页里的「划词工具」一页（语言、规则、模型）。
		*/
		/** 硬依赖：槽位注册表。其余服务一律经 ctx.get 可选读取。 */
		const inject = ["slots"];
		/**
		* 挂载浏览器半边。
		* @param ctx - 客户端 Cordis 上下文。
		*/
		function apply(ctx) {
			ensureStyles();
			const slots = ctx.get?.("slots");
			if (slots === void 0) return;
			slots.inject("shell.overlay", () => slots.register({
				name: "shell.overlay",
				id: "dsh-selection-tools",
				order: 60
			}, () => (0, react.createElement)(Overlay, { ctx })));
			slots.inject("settings.section", () => slots.register({
				name: "settings.section",
				id: "dsh-selection-tools",
				order: 40,
				label: () => detectLocale() === "zh" ? "划词工具" : "Selection tools"
			}, () => (0, react.createElement)(SettingsSection, { ctx })));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map