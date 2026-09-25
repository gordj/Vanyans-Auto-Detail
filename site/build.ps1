# Vanyan's Auto Detail static site build.
# Turns the single-file template.html (hash-routed SPA used for previewing)
# into a real multi-page static site in dist/ that any host can serve.
#
#   powershell -ExecutionPolicy Bypass -File build.ps1
#
# Output: dist/index.html, services.html, work.html, area.html, about.html,
#         book.html, img/, sitemap.xml, robots.txt

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $root 'dist'

# what each button does until Square is switched on
$TEXT_MONTHLY  = 'sms:+18186605845?&body=Hi%2C%20I%20would%20like%20to%20start%20a%20monthly%20plan.'
$TEXT_BIWEEKLY = 'sms:+18186605845?&body=Hi%2C%20I%20would%20like%20to%20start%20a%20plan%20every%20two%20weeks.'
$TEXT_WEEKLY   = 'sms:+18186605845?&body=Hi%2C%20I%20would%20like%20to%20start%20a%20weekly%20plan.'
$EMBED_FALLBACK = '<div class="sq-fallback"><p>Online booking is being switched on. Call or text <a href="tel:+18186605845">818.660.5845</a> and we will put you straight in the book.</p></div>'
$MEMBER_FALLBACK = '<div class="sq-fallback"><p>Your plan is active. Call or text <a href="tel:+18186605845">818.660.5845</a> and we will set your standing slot.</p></div>'

# ---- CONFIGURE BEFORE GOING LIVE -------------------------------------------
$SITE   = 'https://vanyansautodetail.com'       # your domain, no trailing slash
$EMAIL  = 'Vanyansdetailing@gmail.com'          # where the booking form delivers
# ----------------------------------------------------------------------------

# Square is the source of truth for availability, appointments, customers,
# payments and subscriptions. Everything the site needs from it lives in
# square.json. Blank values fall back to the phone and text flow, so a half
# finished Square setup never ships a dead button.
$sq = Get-Content (Join-Path $root 'square.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$SQ_BOOK     = if ($sq.bookingUrl)     { $sq.bookingUrl }     else { '/book' }
$SQ_MONTHLY  = if ($sq.plans.monthly)  { $sq.plans.monthly }  else { $TEXT_MONTHLY }
$SQ_BIWEEKLY = if ($sq.plans.biweekly) { $sq.plans.biweekly } else { $TEXT_BIWEEKLY }
$SQ_WEEKLY   = if ($sq.plans.weekly)   { $sq.plans.weekly }   else { $TEXT_WEEKLY }
$BOOK_BUTTON = '<div class="sq-cta">' +
  '<a class="btn btn-primary gloss" target="_top" rel="nofollow" href="' + $sq.bookingUrl + '">Book now</a></div>'
$SQ_EMBED    = if ($sq.embedHtml) { $sq.embedHtml } elseif ($sq.bookingUrl) { $BOOK_BUTTON } else { $EMBED_FALLBACK }
$SQ_MEMBER   = if ($sq.memberEmbedHtml) { $sq.memberEmbedHtml } else { $MEMBER_FALLBACK }

# Cal.com replaces Square for booking as soon as cal.link is filled in (for example
# "vanyansautodetail" for the whole page, or "vanyansautodetail/full-detail").
# The calendar renders inline on the page from cal-embed.html: no pop-up, no new tab.
$calEmbed = Get-Content (Join-Path $root 'cal-embed.html') -Raw -Encoding UTF8
function Get-CalEmbed($link, $ns) { $calEmbed.Replace('__CALLINK__', $link).Replace('__NS__', $ns) }
if ($sq.cal -and $sq.cal.link)       { $SQ_EMBED  = Get-CalEmbed $sq.cal.link 'book' }
if ($sq.cal -and $sq.cal.memberLink) { $SQ_MEMBER = Get-CalEmbed $sq.cal.memberLink 'member' }

$pages = [ordered]@{
  home = @{
    file  = 'index.html'
    title = "Mobile Car Detailing in Burbank | Vanyan's Auto Detail"
    desc  = 'Mobile detailing that comes to you anywhere within 60 miles of Burbank. Hand wash, paint correction and ceramic coating, 15 years experience, open 24/7. Call 818-660-5845.'
  }
  services = @{
    file  = 'services.html'
    title = "Detailing Prices & Packages | Vanyan's Auto Detail, Burbank"
    desc  = 'Clear out-the-door pricing for mobile detailing in Burbank. Full Detail from $185, Premium Detail from $265, Signature Detail from $385, plus weekly, biweekly and monthly plans.'
  }
  work = @{
    file  = 'work.html'
    title = "Our Work | Vanyan's Auto Detail, Burbank"
    desc  = 'Real cars we have finished in Burbank and across Los Angeles. No stock photos. Every vehicle is posted to Instagram the same week.'
  }
  area = @{
    file  = 'area.html'
    title = "Service Area, 60 Miles from Burbank | Vanyan's Auto Detail"
    desc  = 'Mobile detailing across Burbank, Glendale, Sun Valley, Studio City, Pasadena, Beverly Hills, Brentwood, Granada Hills and Santa Clarita.'
  }
  schedule = @{
    file  = 'schedule.html'
    title = "Schedule Your Plan Visit | Vanyan's Auto Detail"
    desc  = 'Maintenance plan members: pick your day and time. Your visit repeats automatically.'
  }
  about = @{
    file  = 'about.html'
    title = "About Vanyan's Auto Detail, Burbank"
    desc  = 'Fifteen years of detailing, from a shop in Yerevan to a fully mobile operation in Los Angeles.'
  }
  welcome = @{
    file    = 'welcome.html'
    title   = "You are enrolled | Vanyan's Auto Detail"
    desc    = 'Your plan is active. Pick your first appointment time.'
    noindex = $true
  }
  book = @{
    file  = 'book.html'
    title = "Book a Detail | Vanyan's Auto Detail, Burbank"
    desc  = 'Book mobile detailing in Burbank. Call or text 818-660-5845 any hour, or send your vehicle details and we reply with a time and a firm price.'
  }
}

# Cloudflare Pages serves /book, not /book.html, and 308-redirects the latter.
# Every URL we emit uses the clean form so no internal click costs a redirect.
function Get-CleanPath($key) {
  if ($key -eq 'home') { return '/' }
  return '/' + ($pages[$key].file -replace '\.html$', '')
}

$src = Get-Content (Join-Path $root 'template.html') -Raw -Encoding UTF8

# --- images become real files, not base64 (cacheable, far smaller pages) ---
$src = $src -replace '\{\{HERO\}\}',   'img/hero.jpg'
$src = $src -replace '\{\{BEFORE\}\}', 'img/before.jpg'
$src = $src -replace '\{\{AFTER\}\}',  'img/after.jpg'
$src = $src -replace '\{\{LOGO\}\}',   'img/logo.jpg'
$src = $src -replace '\{\{CINEFOAM\}\}',  'img/cine-foam.jpg'
$src = $src -replace '\{\{CINECLEAN\}\}', 'img/cine-clean.jpg'

# --- Square booking and subscription targets ---
$src = $src.Replace('{{SQ_EMBED}}',    $SQ_EMBED)
$src = $src.Replace('{{SQ_MEMBER}}',   $SQ_MEMBER)
$CAL_PLAN_BASE = if ($sq.cal -and $sq.cal.memberLink) { $sq.cal.memberLink.Replace('{plan}', '') } else { 'vanyans-auto.detail/plan-' }
$src = $src.Replace('{{CAL_PLAN_BASE}}', $CAL_PLAN_BASE)
$src = $src.Replace('{{SQ_BOOK}}',     $SQ_BOOK)
$src = $src.Replace('{{SQ_MONTHLY}}',  $SQ_MONTHLY)
$src = $src.Replace('{{SQ_BIWEEKLY}}', $SQ_BIWEEKLY)
$src = $src.Replace('{{SQ_WEEKLY}}',   $SQ_WEEKLY)

# --- the template's own <title> would land inside <body>; the head below owns it ---
$src = [regex]::Replace($src, '(?s)^\s*<title>.*?</title>\s*', '')

# --- strip the preview notice bar ---
$src = [regex]::Replace($src, '(?s)<div class="pv">.*?</div>\s*</div>\s*', '')

# --- hash routes become real page URLs ---
# with a query or anchor first: #/services?tab=ext -> /services?tab=ext, #/#plans -> /#plans
$deepRoute = [System.Text.RegularExpressions.MatchEvaluator]{
  param($m)
  $key = if ($m.Groups[1].Value) { $m.Groups[1].Value } else { 'home' }
  'href="' + (Get-CleanPath $key) + $m.Groups[2].Value + '"'
}
$src = [regex]::Replace($src, 'href="#/([a-z]*)([?#][^"]*)"', $deepRoute)
foreach ($k in $pages.Keys) {
  $target = Get-CleanPath $k
  if ($k -eq 'home') {
    $src = $src.Replace('href="#/"', 'href="' + $target + '"')
  } else {
    $src = $src.Replace('href="#/' + $k + '"', 'href="' + $target + '"')
  }
}


if (Test-Path $dist) { Get-ChildItem $dist -Force | Remove-Item -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dist | Out-Null
Copy-Item (Join-Path $root 'img') (Join-Path $dist 'img') -Recurse -Force

# --- cache busting: every image URL carries a short hash of the file it points to,
#     so a changed photo gets a new URL and no browser can keep showing the old one ---
$imgVersion = @{}
Get-ChildItem (Join-Path $dist 'img') -Recurse -File | ForEach-Object {
  $rel = 'img/' + $_.FullName.Substring((Join-Path $dist 'img').Length + 1).Replace('\', '/')
  $imgVersion[$rel] = (Get-FileHash $_.FullName -Algorithm MD5).Hash.Substring(0, 8).ToLower()
}
$bustImages = [System.Text.RegularExpressions.MatchEvaluator]{
  param($m)
  $v = $imgVersion[$m.Value]
  if ($v) { $m.Value + '?v=' + $v } else { $m.Value }
}

$schema = @"
{"@context":"https://schema.org","@type":"AutoWash","name":"Vanyan's Auto Detail","alternateName":"Van Wash","url":"$SITE","telephone":"+1-818-660-5845","email":"$EMAIL","image":"$SITE/img/logo.jpg","priceRange":"`$`$","currenciesAccepted":"USD","paymentAccepted":"Cash","address":{"@type":"PostalAddress","addressLocality":"Burbank","addressRegion":"CA","addressCountry":"US"},"areaServed":{"@type":"GeoCircle","geoMidpoint":{"@type":"GeoCoordinates","address":"Burbank, CA"},"geoRadius":"96560"},"knowsLanguage":["en","hy","ru"],"openingHoursSpecification":[{"@type":"OpeningHoursSpecification","dayOfWeek":["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"],"opens":"09:00","closes":"17:00"}],"sameAs":["https://www.instagram.com/vanyansautodetail/","https://www.facebook.com/profile.php?id=61576396296196"]}
"@

foreach ($key in $pages.Keys) {
  $p = $pages[$key]
  $doc = $src

  # keep only this page's <main>, and un-hide it
  foreach ($other in $pages.Keys) {
    if ($other -eq $key) { continue }
    $doc = [regex]::Replace($doc, '(?s)<main data-page="' + $other + '".*?</main>\s*', '')
  }
  $doc = $doc.Replace('<main data-page="' + $key + '" hidden>', '<main data-page="' + $key + '">')

  # mark the active nav item server-side so it is correct before JS runs
  $pHref = Get-CleanPath $key
  $doc = $doc.Replace('<a class="pg" href="' + $pHref + '">',
                      '<a class="pg" aria-current="page" href="' + $pHref + '">')

  $canonical = if ($key -eq 'home') { "$SITE/" } else { "$SITE$(Get-CleanPath $key)" }
  $head = @"
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>$($p.title)</title>
<meta name="description" content="$($p.desc)">
<link rel="canonical" href="$canonical">
<meta name="robots" content="$(if ($p.noindex) { 'noindex, nofollow' } else { 'index, follow' })">
<meta name="theme-color" content="#F7F6F3">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Vanyan's Auto Detail">
<meta property="og:title" content="$($p.title)">
<meta property="og:description" content="$($p.desc)">
<meta property="og:url" content="$canonical">
<meta property="og:image" content="$SITE/img/hero.jpg">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="img/logo.jpg">
<link rel="apple-touch-icon" href="img/logo.jpg">
<script type="application/ld+json">$schema</script>
<style>body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
"@

  $out = $head + $doc + "`r`n</body>`r`n</html>`r`n"
  $out = [regex]::Replace($out, 'img/[\w\-/]+\.(?:jpg|jpeg|png|webp|svg)(?!\?v=)', $bustImages)
  [IO.File]::WriteAllText((Join-Path $dist $p.file), $out, (New-Object Text.UTF8Encoding $false))
  "{0,-14} {1,8:N0} bytes" -f $p.file, $out.Length
}

# --- sitemap + robots ---
$urls = ($pages.Keys | Where-Object { -not $pages[$_].noindex } | ForEach-Object {
  $loc = if ($_ -eq 'home') { "$SITE/" } else { "$SITE$(Get-CleanPath $_)" }
  $pri = if ($_ -eq 'home') { '1.0' } else { '0.8' }
  "  <url><loc>$loc</loc><changefreq>monthly</changefreq><priority>$pri</priority></url>"
}) -join "`r`n"

$sitemap = "<?xml version=`"1.0`" encoding=`"UTF-8`"?>`r`n<urlset xmlns=`"http://www.sitemaps.org/schemas/sitemap/0.9`">`r`n$urls`r`n</urlset>`r`n"
[IO.File]::WriteAllText((Join-Path $dist 'sitemap.xml'), $sitemap, (New-Object Text.UTF8Encoding $false))
[IO.File]::WriteAllText((Join-Path $dist 'robots.txt'), "User-agent: *`r`nAllow: /`r`n`r`nSitemap: $SITE/sitemap.xml`r`n", (New-Object Text.UTF8Encoding $false))

"sitemap.xml   written"
"robots.txt    written"
""
"dist total: {0:N0} KB" -f ((Get-ChildItem $dist -Recurse -File | Measure-Object Length -Sum).Sum / 1KB)
