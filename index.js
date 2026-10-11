(() => {
    'use strict';

    const VERSION = '1.5.0';
    const READY_CLASS = 'message-meta-ready';
    const CLICKABLE_CLASS = 'msg-meta-clickable';
    const POPOVER_ID = 'message-meta-popover';
    const USAGE_KEY = 'st_message_usage';
    const FETCH_PATCH_KEY = '__MESSAGE_META_FETCH_PATCH__';
    const BRIDGE_API = '/api/plugins/usage-bridge';
    const bridgeClaimInFlight = new Set();

    // Some setups hand the reply request to a server-side job and read the real
    // response back in base64 pages, so the generation route itself is never
    // fetched from the page. Those pages are reassembled here.
    const RELAY_JOB_RE = /\/api\/plugins\/silly-relay\/jobs(?:\/([a-f0-9]{32}))?(?:[?#]|$)/;
    const RELAY_MARK_KEY = 'silly_relay';
    const RELAY_JOB_TTL_MS = 30 * 60 * 1000;
    const relayJobs = new Map();

    const GENERATION_ROUTES = [
        '/api/backends/chat-completions/generate',
        '/api/backends/text-completions/generate',
        '/api/backends/kobold/generate',
        '/api/backends/text-generation-webui/generate',
        '/api/novelai/generate',
        '/api/azure/generate',
    ];


    const pendingUsages = [];
    let chatObserver = null;
    let renderTimer = 0;
    let listenersAttached = false;
    let eventsAttached = false;
    let saveTimer = 0;

    function getContext() {
        try {
            return globalThis.SillyTavern?.getContext?.() ?? null;
        } catch {
            return null;
        }
    }

    function toDate(value) {
        if (!value) return null;
        if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    function formatDuration(startValue, finishValue) {
        const start = toDate(startValue);
        const finish = toDate(finishValue);
        if (!start || !finish) return '';

        const ms = finish.getTime() - start.getTime();
        if (!Number.isFinite(ms) || ms < 0) return '';

        const seconds = ms / 1000;
        if (seconds < 60) return `${seconds.toFixed(1)}초`;

        const minutes = Math.floor(seconds / 60);
        const rest = Math.round(seconds % 60);
        return `${minutes}분 ${rest}초`;
    }

    function formatNumber(value) {
        const n = Number(value);
        return Number.isFinite(n) ? Math.round(n).toLocaleString('ko-KR') : '';
    }

    function getMessage(messageElement) {
        const context = getContext();
        const id = Number(messageElement?.getAttribute('mesid'));
        if (!context || !Number.isInteger(id) || id < 0) return null;
        return context.chat?.[id] ?? null;
    }

    function getCurrentSwipeInfo(message) {
        if (!message || !Array.isArray(message.swipe_info)) return null;
        const swipeId = Number(message.swipe_id ?? 0);
        return message.swipe_info[swipeId] ?? null;
    }

    function getEffectiveMeta(message) {
        const swipe = getCurrentSwipeInfo(message);
        return {
            genStarted: swipe?.gen_started ?? message?.gen_started,
            genFinished: swipe?.gen_finished ?? message?.gen_finished,
            extra: swipe?.extra ?? message?.extra ?? {},
        };
    }

    function hasOwn(obj, key) {
        return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
    }

    function numberFrom(obj, keys) {
        if (!obj || typeof obj !== 'object') return { found: false, value: null, key: '' };

        for (const key of keys) {
            if (!hasOwn(obj, key)) continue;
            const raw = obj[key];
            if (raw === null || raw === undefined || raw === '') continue;

            const value = Number(raw);
            if (Number.isFinite(value) && value >= 0) {
                return { found: true, value, key };
            }
        }

        return { found: false, value: null, key: '' };
    }

    function nestedNumber(obj, containerKeys, valueKeys) {
        for (const containerKey of containerKeys) {
            const container = obj?.[containerKey];
            const result = numberFrom(container, valueKeys);
            if (result.found) {
                return {
                    ...result,
                    key: `${containerKey}.${result.key}`,
                };
            }
        }
        return { found: false, value: null, key: '' };
    }

    /**
     * Normalize provider-specific token usage shapes.
     *
     * Supported examples:
     * - OpenAI / OpenRouter Chat Completions:
     *   prompt_tokens, completion_tokens, total_tokens,
     *   completion_tokens_details.reasoning_tokens
     * - OpenAI Responses-style:
     *   input_tokens, output_tokens, total_tokens,
     *   output_tokens_details.reasoning_tokens
     * - Gemini / Vertex:
     *   promptTokenCount, candidatesTokenCount, thoughtsTokenCount, totalTokenCount
     *   and snake_case variants
     * - Gemini Interactions-style:
     *   totalInputTokens, totalOutputTokens, totalThoughtTokens, totalTokens
     * - Codex-like:
     *   input_tokens, output_tokens, reasoning_output_tokens, total_tokens
     */
    function normalizeUsage(raw, hints = {}) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

        const input = numberFrom(raw, [
            'prompt_tokens',
            'input_tokens',
            'promptTokenCount',
            'prompt_token_count',
            'inputTokenCount',
            'totalInputTokens',
            'total_input_tokens',
        ]);

        const output = numberFrom(raw, [
            'completion_tokens',
            'output_tokens',
            'candidatesTokenCount',
            'candidates_token_count',
            'outputTokenCount',
            'totalOutputTokens',
            'total_output_tokens',
        ]);

        const total = numberFrom(raw, [
            'total_tokens',
            'totalTokens',
            'totalTokenCount',
            'total_token_count',
        ]);

        const thinkingDirect = numberFrom(raw, [
            'thoughtsTokenCount',
            'thoughts_token_count',
            'thinking_tokens',
            'thinkingTokens',
            'reasoning_tokens',
            'reasoningTokens',
            'reasoning_output_tokens',
            'reasoningOutputTokens',
            'totalThoughtTokens',
            'total_thought_tokens',
        ]);

        const thinkingNested = nestedNumber(
            raw,
            [
                'completion_tokens_details',
                'completionTokensDetails',
                'output_tokens_details',
                'outputTokensDetails',
            ],
            ['reasoning_tokens', 'reasoningTokens', 'thinking_tokens', 'thinkingTokens'],
        );

        const thinking = thinkingNested.found ? thinkingNested : thinkingDirect;

        const geminiShape = [
            'promptTokenCount',
            'prompt_token_count',
            'candidatesTokenCount',
            'candidates_token_count',
            'thoughtsTokenCount',
            'thoughts_token_count',
            'totalInputTokens',
            'totalOutputTokens',
            'totalThoughtTokens',
        ].some(key => hasOwn(raw, key));

        const openAIReasoningShape =
            thinkingNested.found ||
            hasOwn(raw, 'reasoning_output_tokens') ||
            hasOwn(raw, 'reasoningOutputTokens');

        if (!input.found && !output.found && !total.found && !thinking.found) {
            return null;
        }

        let finalTotal = total.value;
        let totalDerived = false;

        // Only derive a total when the relationship is unambiguous.
        if (!total.found && input.found && output.found) {
            if (geminiShape && thinking.found) {
                finalTotal = input.value + output.value + thinking.value;
                totalDerived = true;
            } else {
                // OpenAI/OpenRouter/Codex reasoning is reported as a subset of output.
                finalTotal = input.value + output.value;
                totalDerived = true;
            }
        }

        let thinkingRelation = geminiShape ? 'separate' : (openAIReasoningShape ? 'included' : 'unknown');

        // Proxies that put reasoning_tokens at the top level do not say whether it is
        // part of the output. A reported total settles it.
        if (thinkingRelation === 'unknown' && total.found && input.found && output.found && thinking.found && thinking.value > 0) {
            if (total.value === input.value + output.value + thinking.value) thinkingRelation = 'separate';
            else if (total.value === input.value + output.value) thinkingRelation = 'included';
        }

        return {
            input: input.found ? input.value : null,
            output: output.found ? output.value : null,
            thinking: thinking.found ? thinking.value : null,
            total: Number.isFinite(finalTotal) ? finalTotal : null,

            hasInput: input.found,
            hasOutput: output.found,
            hasThinking: thinking.found,
            hasTotal: total.found || totalDerived,

            totalDerived,
            thinkingRelation,
            format: geminiShape ? 'gemini' : 'openai-compatible',

            model: hints.model || '',
            api: hints.api || '',
            capturedAt: Date.now(),
        };
    }

    function usageScore(usage) {
        if (!usage) return -1;
        let score = 0;
        if (usage.hasInput) score += 2;
        if (usage.hasOutput) score += 2;
        if (usage.hasThinking) score += 2;
        if (usage.hasTotal) score += 2;
        if (usage.model) score += 1;
        return score;
    }

    function extractModel(payload, fallback = '') {
        if (!payload || typeof payload !== 'object') return fallback || '';
        return payload.model ||
            payload.modelVersion ||
            payload.model_version ||
            payload.response?.model ||
            payload.response?.modelVersion ||
            fallback ||
            '';
    }

    function normalizePayloadUsage(payload, hints = {}, depth = 0) {
        if (!payload || depth > 8) return null;

        // Gemini/proxy streaming responses may arrive as a JSON array.
        if (Array.isArray(payload)) {
            let best = null;
            for (const item of payload) {
                const normalized = normalizePayloadUsage(item, hints, depth + 1);
                if (usageScore(normalized) > usageScore(best)) best = normalized;
            }
            return best;
        }

        if (typeof payload !== 'object') return null;

        const model = extractModel(payload, hints.model);
        const api = hints.api || '';

        const candidates = [
            payload.usage,
            payload.usageMetadata,
            payload.usage_metadata,
            payload.tokenUsage,
            payload.token_usage,

            payload.response?.usage,
            payload.response?.usageMetadata,
            payload.response?.usage_metadata,
            payload.response?.tokenUsage,
            payload.response?.token_usage,

            payload.data?.usage,
            payload.data?.usageMetadata,
            payload.data?.usage_metadata,

            payload.result?.usage,
            payload.result?.usageMetadata,
            payload.result?.usage_metadata,

            // Some proxies put usage fields directly at the top level.
            payload,
        ];

        let best = null;

        for (const candidate of candidates) {
            const normalized = normalizeUsage(candidate, { model, api });
            if (usageScore(normalized) > usageScore(best)) best = normalized;
        }

        // Recursively inspect common wrapper containers and arbitrary child arrays/objects.
        // This catches shapes such as:
        // [{ usageMetadata: {...} }]
        // { response: { usageMetadata: {...} } }
        // { data: [{ response: { usageMetadata: {...} } }] }
        for (const [key, value] of Object.entries(payload)) {
            if (!value || typeof value !== 'object') continue;

            // Avoid repeatedly walking token detail arrays; they don't contain aggregate usage.
            if (/TokensDetails$|_tokens_details$|promptTokensDetails|candidatesTokensDetails|cacheTokensDetails/i.test(key)) {
                continue;
            }

            const nested = normalizePayloadUsage(
                value,
                {
                    model: model || hints.model || '',
                    api: api || hints.api || '',
                },
                depth + 1,
            );

            if (usageScore(nested) > usageScore(best)) best = nested;
        }

        return best;
    }

    function mergeUsage(base, next) {
        if (!base) return next;
        if (!next) return base;

        const merged = { ...base };

        for (const key of ['input', 'output', 'thinking', 'total']) {
            if (next[key] !== null && next[key] !== undefined) {
                merged[key] = next[key];
            }
        }

        for (const key of ['hasInput', 'hasOutput', 'hasThinking', 'hasTotal']) {
            merged[key] = Boolean(base[key] || next[key]);
        }

        merged.model = next.model || base.model || '';
        merged.api = next.api || base.api || '';
        merged.format = next.format || base.format || '';
        merged.thinkingRelation = next.thinkingRelation !== 'unknown'
            ? next.thinkingRelation
            : (base.thinkingRelation || 'unknown');
        merged.totalDerived = Boolean(next.totalDerived || base.totalDerived);
        merged.capturedAt = Math.max(base.capturedAt || 0, next.capturedAt || 0);

        return merged;
    }

    function parseRequestHints(input, init) {
        const url = typeof input === 'string'
            ? input
            : (input?.url || '');

        let body = init?.body;
        if (body === undefined && input instanceof Request) {
            // Request bodies cannot be synchronously read here. URL filtering still works.
            body = null;
        }

        let json = null;
        if (typeof body === 'string') {
            try {
                json = JSON.parse(body);
            } catch {
                json = null;
            }
        }

        return {
            url,
            model: json?.model || json?.model_name || '',
            api: json?.chat_completion_source ||
                json?.api_type ||
                json?.source ||
                json?.provider ||
                '',
        };
    }

    function shouldInspectResponse(input, init, url) {
        const method = String(
            init?.method ||
            (typeof Request !== 'undefined' && input instanceof Request ? input.method : '') ||
            'GET'
        ).toUpperCase();

        if (method !== 'POST') return false;

        const value = String(url || '');

        // Only SillyTavern generation routes. Other /api/ responses (e.g. plugin
        // statistics) can carry token-like fields that are not this reply's usage.
        return GENERATION_ROUTES.some(route => value.includes(route));
    }

    function parseSseOrJsonText(text, hints) {
        const trimmed = String(text || '').trim();
        if (!trimmed) return null;

        let best = null;

        const mergeParsed = (parsed) => {
            const usage = normalizePayloadUsage(parsed, hints);
            best = mergeUsage(best, usage);
        };

        // 1) Whole-body JSON: object OR array.
        // Gemini/proxies sometimes return a JSON array of GenerateContentResponse chunks.
        if (
            trimmed.startsWith('{') ||
            trimmed.startsWith('[')
        ) {
            try {
                mergeParsed(JSON.parse(trimmed));
                return best;
            } catch {
                // Fall through: it may be SSE or newline-delimited JSON.
            }
        }

        const lines = trimmed.split(/\r?\n/);

        for (const rawLine of lines) {
            let line = rawLine.trim();
            if (!line) continue;

            // 2) SSE
            if (/^data:/i.test(line)) {
                line = line.replace(/^data:\s*/i, '').trim();
                if (!line || line === '[DONE]') continue;

                try {
                    mergeParsed(JSON.parse(line));
                } catch {
                    // Ignore partial/non-JSON SSE lines.
                }
                continue;
            }

            // 3) NDJSON / JSON-per-line streaming
            if (line.startsWith('{') || line.startsWith('[')) {
                try {
                    mergeParsed(JSON.parse(line));
                } catch {
                    // Ignore incomplete line.
                }
            }
        }

        return best;
    }

    function queueCapturedUsage(usage, meta = {}) {
        if (!usage || usageScore(usage) < 1) return;

        // De-duplicate repeated final streaming chunks.
        const signature = [
            usage.input,
            usage.output,
            usage.thinking,
            usage.total,
            usage.model,
            usage.api,
        ].join('|');

        const now = Date.now();
        const duplicate = pendingUsages.find(entry =>
            !entry.claimed &&
            entry.signature === signature &&
            now - entry.capturedAt < 5000
        );

        if (duplicate) {
            duplicate.usage = mergeUsage(duplicate.usage, usage);
            duplicate.capturedAt = now;
            duplicate.relayJobId ||= meta.relayJobId || '';
            duplicate.requestStartedAt ??= meta.requestStartedAt ?? null;
            return;
        }

        pendingUsages.push({
            usage,
            signature,
            capturedAt: now,
            requestStartedAt: meta.requestStartedAt ?? null,
            relayJobId: meta.relayJobId || '',
            claimed: false,
        });

        while (pendingUsages.length > 30) pendingUsages.shift();

        console.debug('[Message Meta] captured usage:', usage);

        // The reply is usually saved to the chat a moment after its response is read.
        for (const delay of [0, 500, 1500, 4000]) {
            window.setTimeout(tryAttachUsageToRecentAssistant, delay);
        }
    }

    async function inspectGenerationResponse(response, hints, meta) {
        try {
            if (!response?.ok) return;

            const text = await response.text();
            const usage = parseSseOrJsonText(text, hints);
            if (usage) queueCapturedUsage(usage, meta);
        } catch (error) {
            console.debug('[Message Meta] usage inspection skipped:', error);
        }
    }

    function relayRequestInfo(input, init, url) {
        const match = RELAY_JOB_RE.exec(String(url || ''));
        if (!match) return null;

        const method = String(
            init?.method ||
            (typeof Request !== 'undefined' && input instanceof Request ? input.method : '') ||
            'GET'
        ).toUpperCase();

        if (match[1]) return method === 'GET' ? { kind: 'read', id: match[1] } : null;
        return method === 'POST' ? { kind: 'start' } : null;
    }

    function pruneRelayJobs() {
        const now = Date.now();
        for (const [id, job] of relayJobs) {
            if (now - job.seenAt > RELAY_JOB_TTL_MS) relayJobs.delete(id);
        }
    }

    function noteRelayJobStart(init, requestStartedAt) {
        try {
            const envelope = JSON.parse(init?.body);
            const id = String(envelope?.id || '');
            if (!/^[a-f0-9]{32}$/.test(id) || relayJobs.has(id)) return;

            let payload = null;
            try {
                payload = JSON.parse(envelope.body);
            } catch {
                payload = null;
            }

            pruneRelayJobs();
            relayJobs.set(id, {
                hints: {
                    model: payload?.model || payload?.model_name || '',
                    api: payload?.chat_completion_source || payload?.api_type || '',
                },
                requestStartedAt,
                seenAt: Date.now(),
                chunks: [],
                next: 0,
                broken: false,
            });
        } catch {
            // Not a job start envelope.
        }
    }

    async function inspectRelayPage(id, response) {
        try {
            if (!response?.ok) return;

            const data = await response.json();
            if (typeof data?.data !== 'string' || !Number.isInteger(data.cursor) || !Number.isInteger(data.next)) return;

            let job = relayJobs.get(id);
            if (!job) {
                // Recovered after a reload: the start request was made by the previous page.
                pruneRelayJobs();
                job = { hints: {}, requestStartedAt: null, seenAt: Date.now(), chunks: [], next: 0, broken: false };
                relayJobs.set(id, job);
            }

            job.seenAt = Date.now();

            if (data.cursor === job.next) {
                const binary = atob(data.data);
                job.chunks.push(Uint8Array.from(binary, c => c.charCodeAt(0)));
                job.next = data.next;
            } else if (data.cursor > job.next) {
                // Pages before this one were read by a previous page load.
                job.broken = true;
            }

            if (data.state === 'running' || data.next !== data.bytes) return;

            relayJobs.delete(id);
            if (job.broken || job.next !== data.bytes || !(data.status >= 200 && data.status < 300)) return;

            const bytes = new Uint8Array(job.next);
            let offset = 0;
            for (const chunk of job.chunks) {
                bytes.set(chunk, offset);
                offset += chunk.length;
            }

            const usage = parseSseOrJsonText(new TextDecoder().decode(bytes), job.hints);
            if (usage) {
                queueCapturedUsage(usage, {
                    requestStartedAt: job.requestStartedAt,
                    relayJobId: id,
                });
            }
        } catch (error) {
            console.debug('[Message Meta] job usage inspection skipped:', error);
        }
    }

    function patchFetch() {
        if (globalThis[FETCH_PATCH_KEY]) return;

        const originalFetch = globalThis.fetch;
        if (typeof originalFetch !== 'function') return;

        globalThis.fetch = async function stMetaFetch(input, init) {
            const hints = parseRequestHints(input, init);
            const requestStartedAt = Date.now();
            const relay = relayRequestInfo(input, init, hints.url);

            if (relay?.kind === 'start') noteRelayJobStart(init, requestStartedAt);

            const response = await originalFetch.call(this, input, init);

            try {
                if (relay?.kind === 'read') {
                    inspectRelayPage(relay.id, response.clone());
                } else if (shouldInspectResponse(input, init, hints.url)) {
                    inspectGenerationResponse(response.clone(), hints, {
                        requestStartedAt,
                        relayJobId: response.headers?.get?.('x-silly-relay-job') || '',
                    });
                }
            } catch (error) {
                console.debug('[Message Meta] response clone skipped:', error);
            }

            return response;
        };

        globalThis[FETCH_PATCH_KEY] = {
            version: VERSION,
            originalFetch,
        };
    }

    function getStoredUsage(extra) {
        if (!extra || typeof extra !== 'object') return null;

        const stored = extra[USAGE_KEY];
        if (stored && typeof stored === 'object') {
            return stored;
        }

        // Compatibility with messages/plugins that may already have raw provider usage.
        const candidates = [
            extra.usage,
            extra.usageMetadata,
            extra.usage_metadata,
            extra.tokenUsage,
            extra.token_usage,
        ];

        let best = null;
        for (const candidate of candidates) {
            const normalized = normalizeUsage(candidate, {
                model: extra.model || '',
                api: extra.api || '',
            });
            if (usageScore(normalized) > usageScore(best)) best = normalized;
        }

        return best;
    }

    function selectPendingUsageForMessage(message) {
        if (!message || message.is_user || message.is_system) return null;

        const meta = getEffectiveMeta(message);
        const extra = meta.extra ?? {};
        const messageModel = String(extra.model || '').toLowerCase();
        const messageApi = String(extra.api || '').toLowerCase();
        const relayId = String(extra[RELAY_MARK_KEY]?.id || '');
        const started = toDate(meta.genStarted)?.getTime() ?? null;
        const finished = toDate(meta.genFinished)?.getTime() || Date.now();

        // A usage belongs to this reply only if its request was made while this reply
        // was generating (or it is this reply's server job). Anything else is another
        // reply's or a background request's usage and must not be borrowed.
        const belongs = (entry) => {
            if (relayId) return entry.relayJobId === relayId;

            const captured = entry.capturedAt || 0;
            const requested = entry.requestStartedAt;
            if (started === null || requested === null) return Math.abs(captured - finished) < 15000;

            return requested >= started - 1000 && requested <= finished && captured <= finished + 15000;
        };

        const candidates = pendingUsages
            .filter(entry => !entry.claimed)
            .filter(belongs)
            .map(entry => {
                const usageModel = String(entry.usage?.model || '').toLowerCase();
                const usageApi = String(entry.usage?.api || '').toLowerCase();

                let score = 0;
                if (messageModel && usageModel) {
                    if (messageModel === usageModel) score += 8;
                    else if (usageModel.includes(messageModel) || messageModel.includes(usageModel)) score += 5;
                }
                if (messageApi && usageApi && messageApi === usageApi) score += 3;

                return { entry, score };
            })
            // The reply's own response is the last one to finish before it is saved.
            .sort((a, b) => b.score - a.score || (b.entry.capturedAt || 0) - (a.entry.capturedAt || 0));

        return candidates[0]?.entry ?? null;
    }

    function scheduleSaveChat() {
        if (saveTimer) window.clearTimeout(saveTimer);

        saveTimer = window.setTimeout(async () => {
            saveTimer = 0;
            try {
                const context = getContext();
                await context?.saveChat?.();
            } catch (error) {
                console.debug('[Message Meta] usage metadata save skipped:', error);
            }
        }, 350);
    }

    function storeUsageOnMessage(messageId, pendingEntry) {
        const context = getContext();
        const message = context?.chat?.[messageId];

        if (!message || message.is_user || message.is_system || !pendingEntry?.usage) {
            return false;
        }

        message.extra ??= {};

        const usage = {
            ...pendingEntry.usage,
            model: pendingEntry.usage.model || message.extra.model || '',
            api: pendingEntry.usage.api || message.extra.api || '',
        };

        message.extra[USAGE_KEY] = usage;

        // Preserve the same usage data on the active swipe.
        const swipeId = Number(message.swipe_id ?? 0);
        if (Array.isArray(message.swipe_info) && message.swipe_info[swipeId]) {
            message.swipe_info[swipeId].extra ??= {};
            message.swipe_info[swipeId].extra[USAGE_KEY] = structuredClone(usage);
        }

        pendingEntry.claimed = true;
        scheduleSaveChat();
        queueDecorate();

        console.debug('[Message Meta] token usage saved:', messageId, usage);
        return true;
    }

    function attachUsageToMessage(messageId) {
        const context = getContext();
        const id = Number(messageId);
        const message = context?.chat?.[id];

        if (!Number.isInteger(id) || !message || message.is_user || message.is_system) {
            return false;
        }

        // Do not overwrite exact usage already persisted for this swipe/message.
        const meta = getEffectiveMeta(message);
        if (getStoredUsage(meta.extra)) return true;

        const pending = selectPendingUsageForMessage(message);
        if (!pending) return false;

        return storeUsageOnMessage(id, pending);
    }

    async function claimBridgeUsage(messageId) {
        const context = getContext();
        const id = Number(messageId);
        const message = context?.chat?.[id];

        if (!Number.isInteger(id) || !message || message.is_user || message.is_system) {
            return false;
        }

        const meta = getEffectiveMeta(message);
        if (getStoredUsage(meta.extra)) return true;
        if (bridgeClaimInFlight.has(id)) return false;

        bridgeClaimInFlight.add(id);

        try {
            const model = meta.extra?.model || message.extra?.model || '';
            const params = new URLSearchParams();
            if (model) params.set('model', model);

            // Ask only for usage captured while this reply was generating. Ages are
            // relative so the server's clock does not have to match this device's.
            const started = toDate(meta.genStarted)?.getTime();
            const finished = toDate(meta.genFinished)?.getTime();
            if (started) {
                const now = Date.now();
                params.set('maxAge', String(Math.max(1, now - started + 3000)));
                params.set('minAge', String(Math.max(0, now - (finished || now) - 15000)));
            }

            const queryString = params.toString();
            const query = queryString ? `?${queryString}` : '';
            const response = await fetch(`${BRIDGE_API}/claim${query}`, {
                method: 'GET',
                cache: 'no-store',
                credentials: 'same-origin',
                headers: {
                    'Accept': 'application/json',
                },
            });

            if (response.status === 204 || response.status === 404) {
                return false;
            }

            if (!response.ok) {
                console.debug(
                    '[Message Meta] usage bridge claim failed:',
                    response.status,
                );
                return false;
            }

            const data = await response.json();
            const usage = data?.usage;

            if (!usage || typeof usage !== 'object') {
                return false;
            }

            const pendingEntry = {
                usage: {
                    ...usage,
                    model: usage.model || model || '',
                    api: usage.api || meta.extra?.api || message.extra?.api || '',
                },
                claimed: false,
            };

            const saved = storeUsageOnMessage(id, pendingEntry);

            if (saved) {
                console.debug(
                    '[Message Meta] server usage bridge attached:',
                    id,
                    pendingEntry.usage,
                );
            }

            return saved;
        } catch (error) {
            console.debug(
                '[Message Meta] usage bridge unavailable:',
                error,
            );
            return false;
        } finally {
            bridgeClaimInFlight.delete(id);
        }
    }

    function scheduleAttachUsage(messageId) {
        const delays = [40, 180, 500, 1000, 1800, 4000];

        for (const delay of delays) {
            window.setTimeout(async () => {
                if (attachUsageToMessage(messageId)) return;
                await claimBridgeUsage(messageId);
            }, delay);
        }
    }

    function tryAttachUsageToRecentAssistant() {
        const context = getContext();
        const chat = context?.chat;
        if (!Array.isArray(chat) || !chat.length) return;

        for (let id = chat.length - 1; id >= Math.max(0, chat.length - 5); id--) {
            const message = chat[id];
            if (!message?.is_user && !message?.is_system) {
                if (attachUsageToMessage(id)) return;
            }
        }
    }

    function decorateMessages() {
        renderTimer = 0;

        const chatElement = document.querySelector('#chat');
        const context = getContext();
        if (!chatElement || !context?.chat) return;

        document.body.classList.add(READY_CLASS);

        // Include normal messages plus ordinary messages hidden from the AI.
        // SillyTavern renders those hidden messages with is_system="true" but
        // keeps the is_user attribute. Real system notices (.smallSysMes) stay excluded.
        const messageElements = Array.from(
            chatElement.querySelectorAll('.mes[mesid]')
        );

        for (const messageElement of messageElements) {
            const message = getMessage(messageElement);
            if (!message) continue;

            const domSystem = messageElement.getAttribute('is_system');
            const isNormalMessage = domSystem === 'false' || !message.is_system;
            const isHiddenOrdinaryMessage =
                domSystem === 'true'
                && messageElement.hasAttribute('is_user')
                && !messageElement.classList.contains('smallSysMes');

            if (!isNormalMessage && !isHiddenOrdinaryMessage) {
                continue;
            }

            // Keep SillyTavern's original token counter below the avatar.
            const tokenElement = messageElement.querySelector(
                ':scope > .mesAvatarWrapper > .tokenCounterDisplay'
            );

            if (tokenElement) {
                tokenElement.classList.add(CLICKABLE_CLASS);
                tokenElement.title = '메시지 정보 보기';
            }
        }
    }

    function queueDecorate() {
        if (renderTimer) return;
        renderTimer = window.setTimeout(decorateMessages, 40);
    }

    function removePopover() {
        document.getElementById(POPOVER_ID)?.remove();
    }

    function addRow(popover, label, value, options = {}) {
        if (value === undefined || value === null || value === '') return;

        const row = document.createElement('div');
        row.className = 'msg-meta-row';

        if (options.token) row.classList.add('msg-meta-token-row');
        if (options.thinking) row.classList.add('msg-meta-thinking-row');
        if (options.total) row.classList.add('msg-meta-total-row');

        const labelElement = document.createElement('div');
        labelElement.className = 'msg-meta-label';
        labelElement.textContent = label;

        const valueElement = document.createElement('div');
        valueElement.className = 'msg-meta-value';
        valueElement.textContent = String(value);

        row.append(labelElement, valueElement);
        popover.appendChild(row);
    }

    function addSection(popover, text) {
        const section = document.createElement('div');
        section.className = 'msg-meta-section';
        section.textContent = text;
        popover.appendChild(section);
    }

    function addNote(popover, text) {
        if (!text) return;
        const note = document.createElement('div');
        note.className = 'msg-meta-note';
        note.textContent = text;
        popover.appendChild(note);
    }

    function positionPopover(popover, anchor) {
        const anchorRect = anchor.getBoundingClientRect();
        const popRect = popover.getBoundingClientRect();
        const edge = 8;
        const gap = 7;

        let left = anchorRect.left + (anchorRect.width - popRect.width) / 2;
        left = Math.max(edge, Math.min(left, window.innerWidth - popRect.width - edge));

        let top = anchorRect.bottom + gap;
        if (top + popRect.height > window.innerHeight - edge) {
            top = anchorRect.top - popRect.height - gap;
        }
        top = Math.max(edge, top);

        popover.style.left = `${Math.round(left)}px`;
        popover.style.top = `${Math.round(top)}px`;
    }

    function showPopover(tokenElement) {
        const messageElement = tokenElement.closest('.mes[mesid]');
        const message = getMessage(messageElement);
        if (!message) return;

        const meta = getEffectiveMeta(message);
        const extra = meta.extra ?? {};
        const usage = getStoredUsage(extra);

        removePopover();

        const popover = document.createElement('div');
        popover.id = POPOVER_ID;
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-label', '메시지 정보');
        popover.dataset.anchorMesid = messageElement?.getAttribute('mesid') ?? '';

        const title = document.createElement('div');
        title.className = 'msg-meta-title';
        title.textContent = '메시지 정보';
        popover.appendChild(title);

        addRow(popover, 'API', usage?.api || extra.api || '');
        addRow(popover, '모델', usage?.model || extra.model || '');

        if (usage) {
            addSection(popover, '토큰 사용량');

            if (usage.hasInput && usage.input !== null) {
                addRow(popover, 'Input', formatNumber(usage.input), { token: true });
            }

            if (usage.hasOutput && usage.output !== null) {
                addRow(popover, 'Output', formatNumber(usage.output), { token: true });
            }

            if (usage.hasThinking && usage.thinking !== null) {
                addRow(popover, '↳ Thinking', formatNumber(usage.thinking), {
                    token: true,
                    thinking: true,
                });
            }

            if (usage.hasTotal && usage.total !== null) {
                addRow(popover, 'Total', formatNumber(usage.total), {
                    token: true,
                    total: true,
                });
            }

            if (usage.thinkingRelation === 'included' && usage.hasThinking) {
                addNote(popover, 'Thinking은 Output에 포함된 값입니다.');
            } else if (usage.thinkingRelation === 'separate' && usage.hasThinking) {
                addNote(popover, 'Gemini Thinking은 응답 후보(Output)와 별도이며 Total에 포함됩니다.');
            }
        } else {
            // Old messages generally contain only SillyTavern's local message-token count.
            const displayedToken = tokenElement.textContent.replace(/t\s*$/i, '').trim();
            const tokenCount = extra.token_count ?? displayedToken;

            if (tokenCount !== '' && tokenCount !== null && tokenCount !== undefined) {
                addSection(popover, '토큰');
                addRow(popover, '메시지', `${formatNumber(tokenCount)}t`, { token: true });
                if (!message.is_user) {
                    addNote(popover, '상세 usage가 저장되지 않은 기존 메시지입니다.');
                }
            }
        }

        const duration = formatDuration(meta.genStarted, meta.genFinished);
        addRow(popover, '응답 시간', duration);

        const ttft = Number(extra.time_to_first_token);
        if (Number.isFinite(ttft) && ttft > 0) {
            addRow(popover, '첫 토큰', `${(ttft / 1000).toFixed(2)}초`);
        }

        document.body.appendChild(popover);
        positionPopover(popover, tokenElement);
    }

    function onClick(event) {
        const tokenElement = event.target.closest?.(
            `.tokenCounterDisplay.${CLICKABLE_CLASS}`
        );

        if (tokenElement) {
            event.preventDefault();
            event.stopPropagation();

            const messageId = tokenElement.closest('.mes')?.getAttribute('mesid') ?? '';
            const existing = document.getElementById(POPOVER_ID);

            if (existing?.dataset.anchorMesid === messageId) {
                removePopover();
                return;
            }

            showPopover(tokenElement);
            return;
        }

        if (!event.target.closest?.(`#${POPOVER_ID}`)) {
            removePopover();
        }
    }

    function attachDomListeners() {
        if (listenersAttached) return;
        listenersAttached = true;

        document.addEventListener('click', onClick, true);
        window.addEventListener('resize', removePopover, { passive: true });
        document.addEventListener('scroll', removePopover, true);
    }

    function attachSillyTavernEvents() {
        if (eventsAttached) return;

        const context = getContext();
        const eventSource = context?.eventSource;
        const eventTypes = context?.eventTypes;

        if (!eventSource || !eventTypes) return;

        const receiveType = eventTypes.MESSAGE_RECEIVED || 'message_received';
        const renderedType = eventTypes.CHARACTER_MESSAGE_RENDERED || 'character_message_rendered';
        const swipeType = eventTypes.MESSAGE_SWIPED || 'message_swiped';
        const chatChangedType = eventTypes.CHAT_CHANGED || 'chat_id_changed';

        eventSource.on(receiveType, (messageId) => {
            scheduleAttachUsage(messageId);
            queueDecorate();
        });

        eventSource.on(renderedType, (messageId) => {
            scheduleAttachUsage(messageId);
            queueDecorate();
        });

        eventSource.on(swipeType, () => {
            queueDecorate();
        });

        eventSource.on(chatChangedType, () => {
            pendingUsages.length = 0;
            removePopover();
            window.setTimeout(queueDecorate, 80);
        });

        eventsAttached = true;
    }

    function attachObserver() {
        const chatElement = document.querySelector('#chat');
        if (!chatElement || !getContext()?.chat) return false;

        chatObserver?.disconnect();

        chatObserver = new MutationObserver(queueDecorate);
        chatObserver.observe(chatElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['mesid', 'is_user', 'is_system'],
        });

        attachDomListeners();
        attachSillyTavernEvents();
        decorateMessages();

        console.info(`[Message Meta] v${VERSION} loaded`);
        return true;
    }

    function boot() {
        // Patch early so future generation responses can be inspected.
        patchFetch();

        fetch(`${BRIDGE_API}/status`, {
            method: 'GET',
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { 'Accept': 'application/json' },
        })
            .then(async response => {
                if (!response.ok) return;
                const data = await response.json();
                console.info('[Message Meta] server usage bridge:', data);
            })
            .catch(() => {
                // The UI features still work even when the optional server bridge is absent.
            });

        if (attachObserver()) return;

        let attempts = 0;
        const timer = window.setInterval(() => {
            attempts += 1;
            patchFetch();
            attachSillyTavernEvents();

            if (attachObserver() || attempts >= 120) {
                window.clearInterval(timer);
            }
        }, 500);
    }

    boot();
})();
