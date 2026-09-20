<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:output method="html" encoding="UTF-8" omit-xml-declaration="yes"/>

  <xsl:template match="/rss/channel">
    <html lang="en">
      <head>
        <meta charset="UTF-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <title><xsl:value-of select="title"/></title>
        <style>
          :root { color-scheme: dark; --bg:#09090b; --panel:#141417; --line:#29292f; --text:#f4f4f5; --muted:#a1a1aa; --accent:#38bdf8; }
          * { box-sizing:border-box; }
          body { margin:0; background:radial-gradient(circle at 15% 0%,#10283a 0,transparent 34rem),var(--bg); color:var(--text); font:16px/1.65 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
          main { max-width:880px; margin:0 auto; padding:72px 24px; }
          header { border-bottom:1px solid var(--line); margin-bottom:28px; padding-bottom:28px; }
          h1 { font-size:clamp(2rem,5vw,3.4rem); letter-spacing:-.045em; line-height:1.05; margin:0 0 14px; }
          .description { color:var(--muted); max-width:680px; margin:0; }
          .subscribe { display:inline-block; margin-top:20px; color:var(--accent); text-decoration:none; font-weight:650; }
          .subscribe:hover { text-decoration:underline; }
          article { background:color-mix(in srgb,var(--panel) 92%,transparent); border:1px solid var(--line); border-radius:14px; margin:16px 0; padding:24px 26px; transition:border-color .2s,transform .2s; }
          article:hover { border-color:#426477; transform:translateY(-2px); }
          h2 { font-size:1.3rem; line-height:1.25; margin:0 0 8px; }
          h2 a { color:var(--text); text-decoration:none; }
          h2 a:hover { color:var(--accent); }
          time { color:var(--muted); font-size:.9rem; }
          .summary { color:#d4d4d8; margin:14px 0 0; }
          .tags { display:flex; flex-wrap:wrap; gap:7px; margin-top:16px; }
          .tag { border:1px solid #334155; border-radius:999px; color:#bae6fd; font-size:.78rem; padding:2px 9px; }
          footer { color:var(--muted); font-size:.85rem; margin-top:30px; text-align:center; }
          @media (max-width:600px) { main { padding:42px 16px; } article { padding:20px; } }
        </style>
      </head>
      <body>
        <main>
          <header>
            <h1><xsl:value-of select="title"/></h1>
            <p class="description"><xsl:value-of select="description"/></p>
            <a class="subscribe" href="{link}">Visit the blog &#8594;</a>
          </header>
          <section>
            <xsl:for-each select="item">
              <article>
                <h2><a href="{link}"><xsl:value-of select="title"/></a></h2>
                <time><xsl:value-of select="pubDate"/></time>
                <p class="summary"><xsl:value-of select="description"/></p>
                <div class="tags">
                  <xsl:for-each select="category"><span class="tag"><xsl:value-of select="."/></span></xsl:for-each>
                </div>
              </article>
            </xsl:for-each>
          </section>
          <footer>RSS feed · <xsl:value-of select="count(item)"/> posts</footer>
        </main>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
