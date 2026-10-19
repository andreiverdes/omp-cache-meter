-- cache-meter: shows each omp agent's prompt-cache state in Tern's chrome, a toast before expiry and two
-- canvases (all agents, settings). The omp extension of the same name writes one JSON file per pane into
-- <plugin data>/panes/<TERN_PANE>.json; this half only reads them.

local ui = tern.ui
local DIR = tern.plugin.data .. "/panes"

local DEFAULTS = {
	segment = { show = true, format = "countdown+hit", clickOpensCanvas = true },
	tabs = { suffix = true, when = "always" },
	toast = { show = true, leadSeconds = 60, skipFocused = true, skipWarmed = true },
	canvas = { scope = "all-sessions", open = "beside", refreshSeconds = 1 },
}
-- Allowed values of each enum setting, in the order the settings canvas shows them.
local CHOICES = {
	["segment.format"] = { "countdown+hit", "countdown" },
	["tabs.when"] = { "always", "near-expiry" },
	["canvas.scope"] = { "all-sessions", "this-session" },
	["canvas.open"] = { "beside", "tab" },
}

local settings = DEFAULTS
local state = {} -- agent pane id -> its decoded state file
local tab_agent = {} -- tab id -> the agent pane in it that has state
local warned = {} -- agent pane id -> expiresAt already toasted
local last_agent = nil -- agent pane focused most recently, for the history sparkline
local main_canvas, settings_canvas = nil, nil
local ticks = 0

-- Merges the stored settings over the defaults, keeping only values of the default's type and enum.
local function load_settings()
	local stored = tern.kv.get("settings")
	local out = {}
	for group, defaults in DEFAULTS do
		out[group] = {}
		local src = type(stored) == "table" and type(stored[group]) == "table" and stored[group] or {}
		for key, default in defaults do
			local v = src[key]
			local allowed = CHOICES[group .. "." .. key]
			local ok = type(v) == type(default) and (not allowed or table.find(allowed, v) ~= nil)
			if type(v) == "number" and v < 0 then ok = false end
			out[group][key] = if ok then v else default
		end
	end
	settings = out
end

local function save_settings()
	tern.kv.set("settings", settings)
end

local function now_ms()
	return os.time() * 1000
end

local function clock(sec)
	sec = math.max(0, math.ceil(sec))
	return string.format("%d:%02d", sec // 60, sec % 60)
end

local function tokens(n)
	if n >= 1e6 then return string.format("%.2fM", n / 1e6) end
	if n >= 1e3 then return string.format("%.1fk", n / 1e3) end
	return tostring(math.floor(n))
end

-- The same stages and advice the omp meter shows: compacted (/compact dropped the cached prefix), warm,
-- expiring (inside the warn lead and no refresh planned) or cold.
local function stage(s)
	local left = s.expiresAt - now_ms()
	if s.compacted then return "compacted", left, "keep going" end
	local planned = s.warming.scheduled and s.warming.nextWarmAt ~= nil and s.warming.nextWarmAt > now_ms()
	if left <= 0 then return "cold", left, s.coldAdvice end
	if left <= s.warnLeadSeconds * 1000 and not planned then return "expiring", left, "send now" end
	return "warm", left, "keep going"
end

local TONE = { warm = "success", expiring = "warning", cold = "error", compacted = "accent" }

local function load(cx)
	local live = {}
	for _, a in cx.agents:list() do
		live[a.pane] = true
	end
	local in_session = nil
	if settings.canvas.scope == "this-session" then
		in_session = {}
		for _, s in cx.session:sessions() do
			if s.current then
				for _, tab in s.tabs do in_session[tab] = true end
			end
		end
	end
	local pane_tab = {}
	for _, p in cx.session:panes() do
		if p.tab then pane_tab[p.pane] = p.tab end
	end

	state, tab_agent = {}, {}
	if not tern.fs.exists(DIR) then return end
	for _, name in tern.fs.list(DIR) do
		local pane = tonumber(string.match(name, "^(%d+)%.json$"))
		if pane and live[pane] then
			local ok, s = pcall(function()
				return tern.json.decode(tern.fs.read(DIR .. "/" .. name, 262144))
			end)
			if ok and type(s) == "table" and s.v == 1 then
				s.tab = pane_tab[pane]
				state[pane] = s
				if s.tab then tab_agent[s.tab] = pane end
			end
		end
	end
	-- `in_session` only narrows the canvas; chrome still covers every agent.
	for pane, s in state do
		s.listed = in_session == nil or (s.tab ~= nil and in_session[s.tab] == true)
	end
end

tern.chrome.status(function(p)
	if not settings.segment.show then return nil end
	local pane = if state[p.pane] then p.pane elseif p.tab then tab_agent[p.tab] else nil
	local s = pane and state[pane]
	if not s then return nil end
	local st, left = stage(s)
	local text
	if st == "cold" then
		text = "cache cold"
	elseif st == "compacted" then
		text = "cache reset by /compact"
	elseif settings.segment.format == "countdown" then
		text = clock(left / 1000)
	else
		text = string.format("%s · %.1f%% hit", clock(left / 1000), s.last.hitPct)
	end
	return {
		{
			text = "⛁ " .. text,
			tone = TONE[st],
			command = if settings.segment.clickOpensCanvas then "plugin.cache-meter.open" else nil,
		},
	}
end)

tern.chrome.tab_title(function(tab)
	if not settings.tabs.suffix then return nil end
	local pane = tab_agent[tab.id]
	local s = pane and state[pane]
	if not s then return nil end
	local st, left = stage(s)
	if settings.tabs.when == "near-expiry" and (st == "warm" or st == "compacted") then return nil end
	local suffix = if st == "cold" then "cold" elseif st == "compacted" then "compacted" else clock(left / 1000)
	return string.format("%s ⛁ %s", tab.name or tab.title, suffix)
end)

-- A clickable button styled like omp's TSP buttons; `act` may carry a value after `=`.
local function button(label, act, tone)
	return ui.node("row", { role = "omp.btn", actions = { click = act }, title = label, tone = tone }, { ui.text(label) })
end

local function kpi(label, value, tone)
	return ui.card(ui.span(label, "muted"), { ui.text(ui.span(value, "strong " .. (tone or ""))) })
end

local function main_view()
	local rows, actions = {}, {}
	local stake, saved, warm_cost, warms, misses, miss_cost = 0, 0, 0, 0, 0, 0
	local count = 0
	for pane, s in state do
		if s.listed then
			count += 1
			local st, left, advice = stage(s)
			stake += s.prefixTokens
			saved += s.totals.saved
			warm_cost += s.totals.warmCost
			warms += s.totals.warms
			misses += s.totals.misses
			miss_cost += s.totals.missCost
			local total = math.max(1, s.last.total)
			table.insert(rows, {
				{ ui.span(s.label, "strong"), ui.span(" " .. (s.model or ""), "muted") },
				ui.meter_parts_cell({ { s.last.read / total, "success" }, { s.last.write / total, "accent" }, { s.last.uncached / total, "warning" } }),
				string.format("%.1f%%", s.last.hitPct),
				tokens(s.prefixTokens),
				if st == "cold"
					then ui.span("cold " .. clock(-left / 1000) .. " ago", "error")
					elseif st == "compacted" then ui.span("reset by /compact", "accent")
					else { meter = { value = left / s.ttlMs, tone = TONE[st] } },
				ui.span(if st == "cold" or st == "compacted" then "" else clock(left / 1000) .. " · " .. s.tierLabel, "muted"),
				ui.span(s.warming.summary, "muted"),
				ui.span(advice, TONE[st]),
			})
			local buttons = { ui.text(ui.span(s.label, "strong")), button("Focus", "focus=" .. pane) }
			if advice == "compact" then
				table.insert(buttons, button("Compact", "compact=" .. pane, "accent"))
			end
			table.insert(actions, ui.row(buttons))
		end
	end
	if count == 0 then
		return ui.col({
			ui.text(ui.span("No omp agent has published prompt-cache state yet.", "muted")),
			ui.text(ui.span("Install the omp cache-meter extension and send one prompt.", "muted")),
		})
	end
	local parts = {
		ui.row({
			kpi("prefix at stake", tokens(stake)),
			kpi("saved · open sessions", string.format("$%.2f", saved), "success"),
			kpi("warming spent", string.format("$%.2f · %d", warm_cost, warms)),
			kpi("misses · rewrites", string.format("%d · $%.2f", misses, miss_cost), if misses > 0 then "warning" else nil),
		}),
		ui.table({
			{ id = "agent", head = "agent", grow = 1 },
			{ id = "split", head = "last request" },
			{ id = "hit", head = "hit", align = "end" },
			{ id = "prefix", head = "prefix", align = "end" },
			{ id = "exp", head = "expires" },
			{ id = "left", head = "", priority = -1 },
			{ id = "warm", head = "warming", priority = -2, truncate = "end" },
			{ id = "advice", head = "advice" },
		}, rows),
		ui.section("Actions", actions),
	}
	local h = last_agent and state[last_agent]
	if h and h.listed and #h.history > 0 then
		local series = {}
		for i, r in h.history do
			table.insert(series, { (if r.kind == "warm" then "warm " else "turn ") .. i, r.hitPct })
		end
		table.insert(parts, ui.card(h.label .. " · hit rate, last " .. #series .. " requests", { ui.spark(series) }))
	end
	return ui.col(parts)
end

local function main_dock()
	return ui.row({
		ui.text(ui.span("Compact asks that agent to run /compact · Focus switches to its pane", "muted")),
		button("Settings", "settings"),
	})
end

local function enum_row(label, path)
	local group, key = string.match(path, "^(%w+)%.(%w+)$")
	local cells = { ui.text(label) }
	for _, v in CHOICES[path] do
		local current = settings[group][key] == v
		table.insert(cells, button((if current then "● " else "○ ") .. v, "set=" .. path .. ":" .. v, if current then "accent" else nil))
	end
	return ui.row(cells)
end

local function toggle_row(label, path)
	local group, key = string.match(path, "^(%w+)%.(%w+)$")
	local on = settings[group][key]
	return ui.row({ button((if on then "☑ " else "☐ ") .. label, "toggle=" .. path, if on then "accent" else nil) })
end

local function number_row(label, path, unit)
	local group, key = string.match(path, "^(%w+)%.(%w+)$")
	return ui.row({ ui.text(label), ui.text(ui.span(tostring(settings[group][key]) .. " " .. unit, "strong")), button("Change…", "number=" .. path) })
end

local function settings_view()
	return ui.col({
		ui.card("Status line", {
			toggle_row("Show the cache segment for the focused agent", "segment.show"),
			enum_row("Format", "segment.format"),
			toggle_row("Clicking it opens the cache canvas", "segment.clickOpensCanvas"),
		}),
		ui.card("Tab titles", {
			toggle_row("Add a countdown to agent tab titles", "tabs.suffix"),
			enum_row("When", "tabs.when"),
		}),
		ui.card("Toast", {
			toggle_row("Warn before an agent's cache expires", "toast.show"),
			number_row("Lead time", "toast.leadSeconds", "s"),
			toggle_row("Skip the agent you are looking at", "toast.skipFocused"),
			toggle_row("Skip agents omp will warm in time", "toast.skipWarmed"),
		}),
		ui.card("Canvas", {
			enum_row("Agents", "canvas.scope"),
			enum_row("Opens", "canvas.open"),
			number_row("Refresh every", "canvas.refreshSeconds", "s"),
		}),
		ui.text(ui.span("Advice thresholds (when to suggest /compact) belong to the omp extension: run /cache settings in an agent.", "muted")),
		ui.text(ui.span("Tern's status bar must be on for the segment to show (Settings → Appearance).", "muted")),
	})
end

local function settings_dock()
	return ui.row({ ui.text(ui.span("Saved in cache-meter/kv.json · every window", "muted")), button("Reset to defaults", "reset") })
end

local ABOUT_MAIN = "Prompt-cache state of every omp agent, read from the omp cache-meter extension. "
	.. "Focus switches to that agent's pane. Compact sends that agent /compact. Settings opens this plugin's settings."
local ABOUT_SETTINGS = "Settings of the Prompt-cache meter plugin. Each button changes one setting and saves it for every window."

local function is_open(cx, id)
	return id ~= nil and cx.canvas:get(id) ~= nil
end

local function open_main(cx)
	if is_open(cx, main_canvas) then
		cx.canvas:set(main_canvas, { view = main_view(), dock = main_dock() })
		cx.layout:focus(main_canvas)
		return
	end
	main_canvas = cx.canvas:open({
		title = "⛁ Prompt cache",
		view = main_view(),
		dock = main_dock(),
		about = ABOUT_MAIN,
		how = if settings.canvas.open == "tab" then "tab" else "beside",
	})
end

local function open_settings(cx)
	if is_open(cx, settings_canvas) then
		cx.canvas:set(settings_canvas, { view = settings_view(), dock = settings_dock() })
		cx.layout:focus(settings_canvas)
		return
	end
	settings_canvas = cx.canvas:open({
		title = "⛁ Prompt cache · settings",
		view = settings_view(),
		dock = settings_dock(),
		about = ABOUT_SETTINGS,
		how = "beside",
	})
end

local function redraw_settings(cx)
	if is_open(cx, settings_canvas) then
		cx.canvas:set(settings_canvas, { view = settings_view() })
	end
	tern.chrome.refresh()
end

tern.command({ id = "open", title = "Prompt cache: open", icon = "database", run = open_main })
tern.command({ id = "settings", title = "Prompt cache: settings", icon = "settings", run = open_settings })

tern.on("canvas_action", function(ev, cx)
	local act, value = ev.act, ev.value
	if act == "focus" then
		cx.layout:focus(tonumber(value))
	elseif act == "compact" then
		cx.agents:ask(tonumber(value), "/compact")
		cx:toast("info", "Sent /compact", state[tonumber(value)] and state[tonumber(value)].label or nil)
	elseif act == "settings" then
		open_settings(cx)
	elseif act == "toggle" then
		local group, key = string.match(value, "^(%w+)%.(%w+)$")
		settings[group][key] = not settings[group][key]
		save_settings()
		redraw_settings(cx)
	elseif act == "set" then
		local group, key, v = string.match(value, "^(%w+)%.(%w+):(.+)$")
		settings[group][key] = v
		save_settings()
		redraw_settings(cx)
	elseif act == "number" then
		local group, key = string.match(value, "^(%w+)%.(%w+)$")
		cx:prompt({ value = tostring(settings[group][key]), placeholder = "A number, 0 or more" }):next(function(text, _err, cx2)
			local n = tonumber(text)
			if n and n >= 0 then
				settings[group][key] = n
				save_settings()
				if cx2 then redraw_settings(cx2) end
			end
		end)
	elseif act == "reset" then
		tern.kv.set("settings", nil)
		load_settings()
		redraw_settings(cx)
	else
		return false
	end
	return true
end)

tern.on("focus", function(ev, _cx)
	if state[ev.pane] then last_agent = ev.pane end
end)

local function work(cx)
	local ok, err = pcall(function()
		load_settings()
		load(cx)
		local focused = cx.session:focused()
		if focused and state[focused] then last_agent = focused end
		if settings.toast.show then
			for pane, s in state do
				local st, left = stage(s)
				local planned = s.warming.scheduled and s.warming.nextWarmAt ~= nil and s.warming.nextWarmAt > now_ms()
				local due = (st == "warm" or st == "expiring") and left <= settings.toast.leadSeconds * 1000
				local skip = (settings.toast.skipFocused and pane == focused) or (settings.toast.skipWarmed and planned)
				if due and not skip and warned[pane] ~= s.expiresAt then
					warned[pane] = s.expiresAt
					cx:toast(
						"info",
						string.format("%s · prompt cache expires in %d s", s.label, math.ceil(left / 1000)),
						string.format("%s-token prefix · next turn rewrites ≈ $%.2f · %s", tokens(s.prefixTokens), s.rewriteCost, s.warming.summary)
					)
				end
			end
		end
		ticks += 1
		if is_open(cx, main_canvas) and ticks % math.max(1, math.floor(settings.canvas.refreshSeconds)) == 0 then
			cx.canvas:set(main_canvas, { view = main_view() })
		end
		tern.chrome.refresh()
	end)
	if not ok then tern.log.warn("cache-meter:", err) end
end

-- Tern stops a plugin's timers for good once one callback runs past its 50 ms budget, and pcall can't catch
-- that. Right after the machine wakes everything is slow, so the first ticks after a wall-clock jump only
-- re-arm. If a timer still trips, a slower watchdog on Tern's separate `await` budget takes the ticks over.
local SETTLE_MS = 3000
local last_tick, last_wall, settle_until = tern.now(), os.time(), 0

local function tick(cx, rearm)
	rearm()
	if not cx then return end
	local wall = os.time()
	if wall - last_wall > 5 then settle_until = tern.now() + SETTLE_MS end
	last_wall, last_tick = wall, tern.now()
	if last_tick >= settle_until then work(cx) end
end

local function by_sleep(cx)
	tick(cx, function()
		tern.sleep(1000):next(function(_, _, next_cx) by_sleep(next_cx) end)
	end)
end

local function by_timer(cx)
	tick(cx, function() tern.timer(1000, by_timer) end)
end

local function watchdog()
	tern.sleep(5000):next(function(_, _, cx)
		if tern.now() - last_tick > 5000 then by_sleep(cx) else watchdog() end
	end)
end

load_settings()
by_timer(nil)
watchdog()
