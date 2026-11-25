/* rh-tabs */(function(){
  /* Onglets en bas de la page d'écoute : Radio · Clips (style TikTok) · Nouveautés.
     Clips et Nouveautés viennent de Shliah Bot (/radio/clips, /radio/nouveautes). */
  if (!/^\/public\//.test(location.pathname) || /\/dj\/?$/.test(location.pathname) || location.hash) return;
  if (window.__rhTabs) return; window.__rhTabs = true;
  var BOT = "https://agent-shliah-production.up.railway.app";
  var WA = "https://wa.me/33743564227?text=" + encodeURIComponent("Je veux recevoir les nouveautés de la radio 🎵");
  var NOMS = { hayous: "Hayous", nigounim: "Nigounim", calme: "Calme" };
  var COUL = { hayous: "linear-gradient(135deg,#ff8a5c,#e8335e)", nigounim: "linear-gradient(135deg,#f7b733,#c56a1a)", calme: "linear-gradient(135deg,#4facfe,#6a5af9)" };
  var ICO = { hayous: "♫", nigounim: "נ", calme: "☾" };
  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){ return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]; }); }
  function lire(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }
  function ecrire(k, v){ try { localStorage.setItem(k, v); } catch(e){} }
  var SVG = {
    radio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2.2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19A10 10 0 0 1 5 5"/></svg>',
    clips: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2.5" width="14" height="19" rx="3.5"/><path d="M10.5 9.2v5.6l4.4-2.8z" fill="currentColor"/></svg>',
    nouv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>',
    son: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    muet: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    part: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3.5M7.5 8L12 3.5 16.5 8"/><path d="M5 12.5v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>',
    yt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.6 7.2a2.5 2.5 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4A2.5 2.5 0 0 0 2.4 7.2 26 26 0 0 0 2 12a26 26 0 0 0 .4 4.8 2.5 2.5 0 0 0 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4a2.5 2.5 0 0 0 1.8-1.8A26 26 0 0 0 22 12a26 26 0 0 0-.4-4.8zM10 15V9l5.2 3z"/></svg>',
    wa: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.2A9.7 9.7 0 0 0 3.6 16.7L2.3 21.7l5.1-1.3A9.7 9.7 0 1 0 12 2.2zm0 17.7a8 8 0 0 1-4.1-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8 8 0 1 1 12 19.9zm4.4-6c-.2-.1-1.4-.7-1.7-.8-.2-.1-.4-.1-.5.1l-.8 1c-.1.2-.3.2-.5.1a6.5 6.5 0 0 1-3.2-2.8c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.5-.4h-.5a.9.9 0 0 0-.7.3 2.8 2.8 0 0 0-.9 2.1 4.9 4.9 0 0 0 1 2.6 11.2 11.2 0 0 0 4.3 3.8c1.6.7 2.2.7 3 .6a2.6 2.6 0 0 0 1.7-1.2 2.1 2.1 0 0 0 .2-1.2c-.1-.1-.3-.2-.5-.3z"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L9.2 4.5A.8.8 0 0 0 8 5.2z"/></svg>'
  };

  var css = document.createElement("style");
  css.textContent = [
    "#rh-app{padding-bottom:calc(120px + env(safe-area-inset-bottom))!important}",
    "#rh-app.rh-v-clips>:not(.rh-keep),#rh-app.rh-v-nouv>:not(.rh-keep){display:none!important}",
    "#rh-app:not(.rh-v-nouv) #rh-nouv,#rh-app:not(.rh-v-clips) #rh-clips{display:none!important}",
    /* barre d'onglets */
    "#rh-tabbar{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(12px + env(safe-area-inset-bottom));width:calc(100% - 32px);max-width:420px;height:64px;display:flex;border-radius:32px;background:rgba(255,255,255,.78);-webkit-backdrop-filter:saturate(180%) blur(22px);backdrop-filter:saturate(180%) blur(22px);box-shadow:0 10px 30px rgba(0,0,0,.14),inset 0 0 0 .5px rgba(0,0,0,.08);z-index:60}",
    "#rh-tabbar button{flex:1;border:0;background:none;font:inherit;color:rgba(60,60,67,.6);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;font-size:11px;font-weight:600;cursor:pointer;position:relative;-webkit-tap-highlight-color:transparent;transition:color .2s,transform .15s}",
    "#rh-tabbar button:active{transform:scale(.92)}",
    "#rh-tabbar button svg{width:25px;height:25px}",
    "#rh-tabbar button.on{color:#e8335e}",
    "#rh-tabbar .bd{position:absolute;top:7px;left:calc(50% + 7px);min-width:17px;height:17px;padding:0 5px;box-sizing:border-box;border-radius:9px;background:#ff3b30;color:#fff;font-size:11px;line-height:17px;font-weight:700}",
    "#rh-app.rh-v-clips #rh-tabbar{background:rgba(20,20,22,.55);box-shadow:0 10px 30px rgba(0,0,0,.4),inset 0 0 0 .5px rgba(255,255,255,.12)}",
    "#rh-app.rh-v-clips #rh-tabbar button{color:rgba(255,255,255,.6)}#rh-app.rh-v-clips #rh-tabbar button.on{color:#fff}",
    "@media (prefers-color-scheme:dark){#rh-tabbar{background:rgba(28,28,30,.78);box-shadow:0 10px 30px rgba(0,0,0,.5),inset 0 0 0 .5px rgba(255,255,255,.1)}#rh-tabbar button{color:rgba(235,235,245,.6)}#rh-tabbar button.on{color:#ff5c7f}}",
    /* nouveautés */
    "#rh-nouv h1{font-size:36px;font-weight:800;letter-spacing:-.6px;margin:10px 0 4px}",
    "#rh-nouv .sub{color:rgba(60,60,67,.6);font-size:16px;margin:0 0 18px}",
    "#rh-nouv .wa{display:flex;align-items:center;gap:14px;padding:14px 16px;margin:0 0 18px;border-radius:18px;background:linear-gradient(135deg,#25d366,#128c7e);color:#fff;text-decoration:none;box-shadow:0 10px 24px rgba(18,140,126,.28);-webkit-tap-highlight-color:transparent;transition:transform .15s}",
    "#rh-nouv .wa:active{transform:scale(.97)}",
    "#rh-nouv .wa .ic{width:44px;height:44px;border-radius:12px;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;flex-shrink:0}#rh-nouv .wa .ic svg{width:26px;height:26px}",
    "#rh-nouv .wa .tx2{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}#rh-nouv .wa b{font-size:17px}#rh-nouv .wa small{font-size:13px;opacity:.9}",
    "#rh-nouv .wa .go{font-size:28px;opacity:.8;line-height:1}",
    "#rh-nouv .chips{display:flex;gap:8px;overflow-x:auto;margin:0 -20px 14px;padding:0 20px;scrollbar-width:none}#rh-nouv .chips::-webkit-scrollbar{display:none}",
    "#rh-nouv .chips button{border:0;font:inherit;font-size:15px;font-weight:600;padding:8px 16px;border-radius:20px;background:rgba(118,118,128,.12);color:inherit;white-space:nowrap;cursor:pointer}",
    "#rh-nouv .chips button.on{background:#000;color:#fff}",
    "#rh-nouv .row{display:flex;align-items:center;gap:14px;padding:10px 0;border-bottom:.5px solid rgba(60,60,67,.18);cursor:pointer;-webkit-tap-highlight-color:transparent}",
    "#rh-nouv .row:active{opacity:.6}",
    "#rh-nouv .art{width:58px;height:58px;border-radius:12px;flex-shrink:0;background-size:cover;background-position:center;display:flex;align-items:center;justify-content:center;color:#fff;font-size:24px;box-shadow:0 4px 12px rgba(0,0,0,.12)}",
    "#rh-nouv .tx{flex:1;min-width:0}",
    "#rh-nouv .tt{font-size:17px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    "#rh-nouv .mt{font-size:14px;color:rgba(60,60,67,.6);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    "#rh-nouv .nw{font-size:11px;font-weight:700;color:#e8335e;background:rgba(232,51,94,.1);padding:3px 8px;border-radius:10px;flex-shrink:0}",
    "#rh-nouv .vide{text-align:center;color:rgba(60,60,67,.6);padding:50px 10px;font-size:16px;line-height:1.5}",
    "@media (prefers-color-scheme:dark){#rh-nouv .sub,#rh-nouv .mt,#rh-nouv .vide{color:rgba(235,235,245,.6)}#rh-nouv .chips button.on{background:#fff;color:#000}#rh-nouv .row{border-color:rgba(84,84,88,.5)}}",
    /* clips */
    "#rh-clips{position:fixed;inset:0;background:#000;z-index:50;color:#fff}",
    "#rh-clips .feed{position:absolute;inset:0;overflow-y:scroll;scroll-snap-type:y mandatory;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;scrollbar-width:none}#rh-clips .feed::-webkit-scrollbar{display:none}",
    "#rh-clips .sl{position:relative;height:100vh;height:100dvh;scroll-snap-align:start;scroll-snap-stop:always;overflow:hidden;display:flex;align-items:center;justify-content:center}",
    "#rh-clips .bg{position:absolute;inset:-40px;background-size:cover;background-position:center;filter:blur(36px) brightness(.45) saturate(1.3);transform:scale(1.1)}",
    "#rh-clips .fr{position:relative;width:100%;max-width:min(100vw,900px);aspect-ratio:16/9;background:#000 center/cover no-repeat;box-shadow:0 20px 60px rgba(0,0,0,.5)}",
    "#rh-clips .fr .pl{position:absolute;left:50%;top:50%;width:64px;height:64px;margin:-32px 0 0 -32px;border-radius:50%;background:rgba(0,0,0,.45);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;transition:opacity .25s}",
    "#rh-clips .fr .pl svg{width:30px;height:30px;margin-left:3px}",
    "#rh-clips .info{position:absolute;left:18px;right:84px;bottom:calc(122px + env(safe-area-inset-bottom));text-shadow:0 1px 8px rgba(0,0,0,.6)}",
    "#rh-clips .info .tt{font-size:19px;font-weight:700;line-height:1.25;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}",
    "#rh-clips .info .au{font-size:15px;opacity:.85;margin-top:5px}",
    "#rh-clips .side{position:absolute;right:12px;bottom:calc(122px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:18px}",
    "#rh-clips .side button,#rh-clips .side a{width:50px;height:50px;border-radius:50%;border:0;background:rgba(255,255,255,.16);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:transform .15s}",
    "#rh-clips .side button:active,#rh-clips .side a:active{transform:scale(.88)}",
    "#rh-clips .side svg{width:24px;height:24px}",
    "#rh-clips .top{position:absolute;left:0;right:0;top:0;padding:calc(14px + env(safe-area-inset-top)) 18px 30px;background:linear-gradient(rgba(0,0,0,.45),transparent);font-size:17px;font-weight:700;z-index:3;pointer-events:none;display:flex;justify-content:space-between;align-items:center}",
    "#rh-clips .top .n{font-size:13px;font-weight:600;opacity:.7}",
    "#rh-clips .snd{position:absolute;left:50%;transform:translateX(-50%);top:calc(60px + env(safe-area-inset-top));z-index:4;border:0;font:inherit;font-size:15px;font-weight:600;color:#000;background:#fff;padding:10px 18px;border-radius:22px;display:flex;align-items:center;gap:8px;box-shadow:0 8px 24px rgba(0,0,0,.35);cursor:pointer;animation:rhPulse 2s ease-in-out infinite}",
    "#rh-clips .snd svg{width:20px;height:20px}",
    "@keyframes rhPulse{0%,100%{transform:translateX(-50%) scale(1)}50%{transform:translateX(-50%) scale(1.05)}}",
    "#rh-yt-wrap{position:fixed;z-index:2;opacity:0;pointer-events:none;transition:opacity .35s;background:#000}",
    "#rh-yt-wrap.vu{opacity:1}",
    "#rh-yt-wrap iframe{width:100%;height:100%;border:0;display:block}",
    "#rh-clips .vide{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:30px;gap:10px;color:rgba(255,255,255,.75);font-size:16px;line-height:1.5}",
    "#rh-clips .vide b{color:#fff;font-size:22px}",
    "#rh-clips .hint{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(88px + env(safe-area-inset-bottom));font-size:13px;opacity:.7;white-space:nowrap;pointer-events:none;transition:opacity .6s}"
  ].join("\n");
  document.head.appendChild(css);

  var app, vue = "radio", clips = [], musiques = [], filtre = "tous";
  var feed, actif = -1, player = null, pret = false, sonActif = false, wrap;

  function attendre(){
    app = document.getElementById("rh-app");
    if (!app) return setTimeout(attendre, 150);
    construire();
  }

  function construire(){
    // panneaux
    var n = document.createElement("div"); n.id = "rh-nouv"; n.className = "rh-keep";
    n.innerHTML = '<h1>Nouveautés</h1><p class="sub">Les dernières musiques ajoutées sur vos radios</p>' +
      '<a class="wa" href="' + WA + '" target="_blank" rel="noopener"><span class="ic">' + SVG.wa + '</span><span class="tx2"><b>Recevoir les nouveautés</b><small>Un message WhatsApp à chaque nouvelle musique</small></span><span class="go">›</span></a>' +
      '<div class="chips" id="rh-ch"></div><div id="rh-nl"><div class="vide">Chargement…</div></div>';
    app.appendChild(n);
    var c = document.createElement("div"); c.id = "rh-clips"; c.className = "rh-keep";
    c.innerHTML = '<div class="top"><span>Clips</span><span class="n" id="rh-cn"></span></div><div class="feed" id="rh-feed"></div>';
    app.appendChild(c);
    feed = c.querySelector("#rh-feed");
    // barre
    var t = document.createElement("nav"); t.id = "rh-tabbar"; t.className = "rh-keep";
    t.innerHTML = '<button data-v="radio" class="on">' + SVG.radio + 'Radio</button>' +
      '<button data-v="clips">' + SVG.clips + 'Clips<span class="bd" id="rh-bd-c" hidden></span></button>' +
      '<button data-v="nouv">' + SVG.nouv + 'Nouveautés<span class="bd" id="rh-bd-n" hidden></span></button>';
    app.appendChild(t);
    t.addEventListener("click", function(e){ var b = e.target.closest("button[data-v]"); if (b) montrer(b.getAttribute("data-v")); });
    n.addEventListener("click", clicNouv);
    app.classList.add("rh-v-radio");
    charger();
    setInterval(charger, 5 * 60 * 1000);
  }

  function montrer(v){
    if (v === vue) { if (v === "clips" && feed) feed.scrollTo({ top: 0, behavior: "smooth" }); else window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    vue = v;
    app.classList.remove("rh-v-radio", "rh-v-clips", "rh-v-nouv"); app.classList.add("rh-v-" + v);
    [].forEach.call(document.querySelectorAll("#rh-tabbar button"), function(b){ b.classList.toggle("on", b.getAttribute("data-v") === v); });
    window.scrollTo(0, 0);
    document.documentElement.style.overflow = v === "clips" ? "hidden" : "";
    if (v === "clips") { vu("rh_clips_vu", clips.length ? clips[0].id : 0); badges(); entrerClips(); }
    else { pauseClip(); if (wrap) wrap.classList.remove("vu"); }
    if (v === "nouv") { vu("rh_nouv_vu", musiques.length ? musiques[0].ajoute : 0); badges(); }
  }
  function vu(k, val){ if (val) ecrire(k, String(val)); }

  function charger(){
    fetch(BOT + "/radio/clips").then(function(r){ return r.json(); }).then(function(d){
      var neuf = (d.clips || []);
      var change = neuf.map(function(x){ return x.id; }).join() !== clips.map(function(x){ return x.id; }).join();
      clips = neuf; badges();
      if (change) dessinerClips();
    }).catch(function(){ if (!clips.length) feed.innerHTML = '<div class="vide"><b>Pas de connexion</b>Réessayez dans un instant.</div>'; });
    fetch(BOT + "/radio/nouveautes").then(function(r){ return r.json(); }).then(function(d){
      musiques = d.musiques || []; badges(); dessinerNouv();
    }).catch(function(){ document.getElementById("rh-nl").innerHTML = '<div class="vide">Pas de connexion.<br>Réessayez dans un instant.</div>'; });
  }
  function badges(){
    var vc = +(lire("rh_clips_vu") || 0), vn = +(lire("rh_nouv_vu") || 0);
    var nc = vc ? clips.filter(function(x){ return x.id > vc; }).length : 0;
    var nn = vn ? musiques.filter(function(x){ return x.ajoute > vn; }).length : Math.min(musiques.filter(function(x){ return Date.now()/1000 - x.ajoute < 3*86400; }).length, 9);
    if (vue === "clips") nc = 0; if (vue === "nouv") nn = 0;
    var bc = document.getElementById("rh-bd-c"), bn = document.getElementById("rh-bd-n");
    bc.hidden = !nc; bc.textContent = nc > 9 ? "9+" : nc;
    bn.hidden = !nn; bn.textContent = nn > 9 ? "9+" : nn;
  }

  /* ---------- Nouveautés ---------- */
  function depuis(ts){
    var s = Date.now()/1000 - ts;
    if (s < 3600) return "à l'instant"; if (s < 86400) return "il y a " + Math.floor(s/3600) + " h";
    var j = Math.floor(s/86400); if (j === 1) return "hier"; if (j < 30) return "il y a " + j + " j";
    return new Date(ts*1000).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  }
  function dessinerNouv(){
    var radios = ["tous"].concat(Object.keys(NOMS).filter(function(k){ return musiques.some(function(m){ return m.radio === k; }); }));
    document.getElementById("rh-ch").innerHTML = radios.length > 2 ? radios.map(function(k){ return '<button data-f="' + k + '" class="' + (filtre === k ? "on" : "") + '">' + (k === "tous" ? "Toutes" : NOMS[k]) + '</button>'; }).join("") : "";
    var l = musiques.filter(function(m){ return filtre === "tous" || m.radio === filtre; });
    document.getElementById("rh-nl").innerHTML = l.length ? l.map(function(m){
      var art = m.pochette ? 'style="background-image:url(\'' + esc(m.pochette) + '\'),' + COUL[m.radio] + '"' : 'style="background:' + COUL[m.radio] + '"';
      return '<div class="row" data-r="' + esc(m.radio) + '"><div class="art" ' + art + '>' + (m.pochette ? "" : ICO[m.radio]) + '</div><div class="tx"><div class="tt">' + esc(m.titre) + '</div><div class="mt">' + (m.artiste ? esc(m.artiste) + " · " : "") + "Radio " + NOMS[m.radio] + " · " + depuis(m.ajoute) + '</div></div>' + (Date.now()/1000 - m.ajoute < 7*86400 ? '<span class="nw">NOUVEAU</span>' : "") + '</div>';
    }).join("") : '<div class="vide">Pas encore de nouveautés.<br>Elles apparaîtront ici dès qu\'une musique sera ajoutée.</div>';
  }
  function clicNouv(e){
    var f = e.target.closest("[data-f]"); if (f) { filtre = f.getAttribute("data-f"); dessinerNouv(); return; }
    var r = e.target.closest(".row[data-r]"); if (!r) return;
    montrer("radio");
    var b = document.querySelector('#rh-app .rh-btn[data-code="' + r.getAttribute("data-r") + '"]');
    if (b && !b.classList.contains("rh-on")) b.click();
  }

  /* ---------- Clips (style TikTok) ---------- */
  function mini(c){ return "https://i.ytimg.com/vi/" + c.youtube_id + "/hqdefault.jpg"; }
  function dessinerClips(){
    document.getElementById("rh-cn").textContent = clips.length ? clips.length + " clip" + (clips.length > 1 ? "s" : "") : "";
    if (!clips.length) { feed.innerHTML = '<div class="vide"><b>Bientôt des clips</b>Les clips de vos chanteurs préférés arrivent ici.</div>'; return; }
    feed.innerHTML = clips.map(function(c, i){
      return '<section class="sl" data-i="' + i + '"><div class="bg" style="background-image:url(\'' + mini(c) + '\')"></div>' +
        '<div class="fr" style="background-image:url(\'' + mini(c) + '\')"><div class="pl">' + SVG.play + '</div></div>' +
        '<div class="info"><div class="tt">' + esc(c.titre || "Clip") + '</div>' + (c.auteur ? '<div class="au">' + esc(c.auteur) + '</div>' : "") + '</div>' +
        '<div class="side"><button data-a="son" aria-label="Son">' + (sonActif ? SVG.son : SVG.muet) + '</button><button data-a="part" aria-label="Partager">' + SVG.part + '</button><a href="' + esc(c.lien) + '" target="_blank" rel="noopener" aria-label="Ouvrir sur YouTube">' + SVG.yt + '</a></div></section>';
    }).join("") + (clips.length > 1 ? '<div class="hint" id="rh-hint">Glissez vers le haut pour le clip suivant</div>' : "");
    actif = -1;
    var obs = new IntersectionObserver(function(es){
      es.forEach(function(en){ if (en.isIntersecting && en.intersectionRatio > .6) choisir(+en.target.getAttribute("data-i")); });
    }, { root: feed, threshold: [.6] });
    [].forEach.call(feed.querySelectorAll(".sl"), function(s){ obs.observe(s); });
    feed.onclick = clicClip;
    feed.onscroll = function(){
      if (wrap && actif >= 0) { var s = feed.children[actif]; if (s) { var d = Math.abs(s.offsetTop - feed.scrollTop);
        if (d > 40) wrap.classList.remove("vu"); else if (d < 4 && pret && player.getPlayerState() === 1) { placer(); wrap.classList.add("vu"); } } } var h = document.getElementById("rh-hint"); if (h && feed.scrollTop > 50) h.style.opacity = 0; };
    if (vue === "clips") entrerClips();
  }
  function entrerClips(){
    if (!clips.length) return;
    chargerYT();
    var i = Math.round(feed.scrollTop / (feed.clientHeight || 1));
    actif = -1; choisir(Math.max(0, Math.min(clips.length - 1, i)));
  }
  function placer(){
    if (!wrap || actif < 0 || !feed.children[actif]) return;
    // position finale du cadre une fois le clip bien calé en haut de l'écran
    var sl = feed.children[actif], fr = sl.querySelector(".fr").getBoundingClientRect();
    var top = fr.top - sl.getBoundingClientRect().top + feed.getBoundingClientRect().top;
    [wrap].forEach(function(el){ el.style.left = fr.left + "px"; el.style.top = top + "px"; el.style.width = fr.width + "px"; el.style.height = fr.height + "px"; });
  }
  function choisir(i){
    if (vue !== "clips" || i === actif || !clips[i]) return;
    actif = i;
    if (wrap) wrap.classList.remove("vu");
    var pl = feed.children[i] && feed.children[i].querySelector(".pl"); if (pl) pl.style.opacity = 1;
    if (!pret) return;
    placer();
    player.loadVideoById({ videoId: clips[i].youtube_id });
    if (sonActif) { player.unMute(); player.setVolume(100); } else player.mute();
    var attendu = clips[i].youtube_id;
    setTimeout(function(){
      // Si le navigateur refuse le son automatique, on repart en muet et on propose « Activer le son »
      if (actif < 0 || clips[actif].youtube_id !== attendu || !player.getPlayerState) return;
      if (player.getPlayerState() !== 1) { player.mute(); player.playVideo(); if (sonActif) { sonActif = false; maj(); } }
    }, 2500);
  }
  function chargerYT(){
    if (wrap) return;
    wrap = document.createElement("div"); wrap.id = "rh-yt-wrap"; wrap.innerHTML = '<div id="rh-yt"></div>';
    document.getElementById("rh-clips").appendChild(wrap);
    var snd = document.createElement("button"); snd.className = "snd"; snd.id = "rh-snd"; snd.innerHTML = SVG.son + "Activer le son";
    snd.onclick = activerSon;
    document.getElementById("rh-clips").appendChild(snd);
    window.addEventListener("resize", placer);
    var prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function(){ if (prev) try { prev(); } catch(e){} creerPlayer(); };
    if (window.YT && window.YT.Player) creerPlayer();
    else { var s = document.createElement("script"); s.src = "https://www.youtube.com/iframe_api"; document.head.appendChild(s); }
  }
  function creerPlayer(){
    if (player) return;
    player = new YT.Player("rh-yt", {
      width: "100%", height: "100%",
      playerVars: { playsinline: 1, controls: 0, rel: 0, modestbranding: 1, iv_load_policy: 3, fs: 0, disablekb: 1, mute: 1, origin: location.origin },
      events: {
        onReady: function(){ pret = true; var i = actif; actif = -1; if (vue === "clips") choisir(i < 0 ? 0 : i); },
        onStateChange: function(e){
          if (e.data === 1) { if (wrap) wrap.classList.add("vu"); var pl = feed.children[actif] && feed.children[actif].querySelector(".pl"); if (pl) pl.style.opacity = 0; placer(); }
          if (e.data === 0 && actif + 1 < clips.length) feed.children[actif + 1].scrollIntoView({ behavior: "smooth" });
          if (e.data === 0 && actif + 1 >= clips.length) { player.seekTo(0); player.playVideo(); }
        }
      }
    });
  }
  function activerSon(){
    sonActif = true; maj();
    if (pret) { player.unMute(); player.setVolume(100); player.playVideo(); }
    // On coupe la radio pour ne pas avoir deux sons en même temps
    var on = document.querySelector("#rh-app .rh-btn.rh-on"); if (on) on.click();
  }
  function maj(){
    var b = document.getElementById("rh-snd"); if (b) b.style.display = sonActif ? "none" : "";
    [].forEach.call(feed.querySelectorAll('[data-a="son"]'), function(x){ x.innerHTML = sonActif ? SVG.son : SVG.muet; });
  }
  function pauseClip(){ if (pret && player.pauseVideo) player.pauseVideo(); }
  function clicClip(e){
    // toucher la vidéo : pause / lecture (le lecteur YouTube laisse passer les gestes pour glisser)
    if (e.target.closest(".fr")) { if (pret) { if (player.getPlayerState() === 1) player.pauseVideo(); else player.playVideo(); } return; }
    var a = e.target.closest("[data-a]"); if (!a) return;
    var c = clips[+a.closest(".sl").getAttribute("data-i")];
    if (a.getAttribute("data-a") === "son") { if (sonActif) { sonActif = false; maj(); if (pret) player.mute(); } else activerSon(); }
    if (a.getAttribute("data-a") === "part") {
      var d = { title: c.titre || "Clip", text: (c.titre || "Un clip") + " — via Radio Hayous", url: c.lien };
      if (navigator.share) navigator.share(d).catch(function(){}); else { try { navigator.clipboard.writeText(c.lien); a.style.background = "rgba(52,199,89,.6)"; setTimeout(function(){ a.style.background = ""; }, 900); } catch(err){} }
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attendre); else attendre();
})();
