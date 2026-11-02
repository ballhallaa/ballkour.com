/* Cloudflare Worker for ballkour.com: puts the Discord widget data into the page as Cloudflare serves it.

   Without this, the browser has to ask Discord for the online count after the page loads, so the
   "• N online" pills next to "Join our Discord" pop in a moment late and widen the buttons. With it:
   - each pill already has its count and is visible in the HTML that arrives (in English, like the rest
     of the page's first paint; the page's script re-renders it in the visitor's language)
   - the widget data goes into <head> as <script type="application/json" id="discord-widget">, so the
     voice channel list renders straight away too

   Discord's answer is cached at Cloudflare for 60 seconds, so Discord sees at most about one request a
   minute per Cloudflare location. If Discord is slow (over 1.5 s) or down, the page is served untouched
   and the browser fetches the count itself, as before. Anything that isn't a page passes straight through. */

const GUILD_ID = "1212553452283101245";
const WIDGET_URL = `https://discord.com/api/guilds/${GUILD_ID}/widget.json`;

async function getWidget() {
  try {
    const r = await fetch(WIDGET_URL, { cf: { cacheTtl: 60, cacheEverything: true }, signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const d = await r.json();
    if (typeof d.presence_count !== "number") return null;
    // Only what the page uses: the count, the channel names, and which channel each member is in
    return {
      presence_count: d.presence_count,
      channels: (d.channels || []).map(({ id, name, position }) => ({ id, name, position })),
      members: (d.members || []).filter((m) => m.channel_id).map((m) => ({ channel_id: m.channel_id })),
    };
  } catch (e) {
    return null;
  }
}

export default {
  async fetch(request, env, ctx) {
    // If anything here throws, Cloudflare serves the page from the VPS as if the Worker weren't there
    ctx.passThroughOnException();
    const isPage = request.method === "GET" && (request.headers.get("Accept") || "").includes("text/html");
    if (!isPage) return fetch(request);

    // Ask for the full page every time (no 304 Not Modified), so a browser never reuses an old count from its cache
    const headers = new Headers(request.headers);
    headers.delete("If-None-Match");
    headers.delete("If-Modified-Since");
    const [res, widget] = await Promise.all([fetch(new Request(request, { headers })), getWidget()]);
    if (!widget || !res.ok || !(res.headers.get("Content-Type") || "").includes("text/html")) return res;

    const out = new Response(res.body, res);
    out.headers.delete("ETag");
    out.headers.delete("Last-Modified");
    out.headers.set("Cache-Control", "no-cache");

    const text = `${widget.presence_count.toLocaleString("en")} online`;
    const json = JSON.stringify(widget).replace(/</g, "\\u003c");
    return new HTMLRewriter()
      .on("head", { element(el) { el.append(`<script type="application/json" id="discord-widget">${json}</script>`, { html: true }); } })
      .on("[data-online-wrap]", { element(el) { el.removeAttribute("hidden"); } })
      .on("[data-online]", { element(el) { el.setInnerContent(text); } })
      .transform(out);
  },
};
