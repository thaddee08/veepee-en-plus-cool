# RESTPOST

A small sale-discovery page for Germany: real sale items from brand and retailer shops, a style quiz, and an outfit builder.

## How the sale feed works

`index.html` loads `data/offers.json`. If that file is missing (for example when you open `index.html` straight from disk), it falls back to the sample items built into the page.

`data/offers.json` is built by `scripts/fetch-offers.mjs` from the sources in `feeds.config.json`:

- **Shops on Shopify**: brand shops (HOMEBOY, Dickies, Reebok, A.P.C., Armedangels, 6PM, Rains, Represent), plus Nike and Jordan from the German sneaker shops Asphaltgold, Afew and Overkill. Nike's own site doesn't offer its catalogue this way. Every Shopify shop publishes its catalogue at `/products.json`. The script keeps items that are in stock and marked down by at least `minDiscountPercent`, and only reads shops that price in euros. These need no account.
- **Retailers through AWIN** (for example SNIPES or Zalando). Big retailers block scraping, so their sale items come from affiliate product feeds. You need an AWIN publisher account and to be accepted into each retailer's programme. Links from these feeds are affiliate links and the page marks them "Ad".

A GitHub Action (`.github/workflows/refresh-offers.yml`) runs the script twice a day (06:23 and 18:23 German summer time), commits the new `data/offers.json`, and deploys the site to GitHub Pages. Pushes to `main` redeploy the site without refreshing the feed.

To refresh by hand:

```bash
node scripts/fetch-offers.mjs
```

Then serve the folder (for example with `python3 -m http.server`) rather than opening the file directly, so the page can load the feed.

## Setup

1. **Publish the page.** In the repo, go to Settings → Pages → Build and deployment, and set Source to **GitHub Actions**. (Deploying straight from the branch wouldn't pick up the feed updates: commits made by a workflow don't trigger branch-based Pages builds.)
2. **Let the workflow run.** Actions → "Refresh sale feed" → Run workflow. After that it runs twice a day on its own.
3. **Add AWIN retailers (optional).** In AWIN, open Toolbox → Create-a-Feed, pick the retailers' feeds, language German, and at least these columns: `aw_deep_link`, `product_name`, `merchant_name`, `brand_name`, `search_price`, `product_price_old`, `rrp_price`, `currency`, `in_stock`, `merchant_image_url`, `large_image`, `merchant_category`, `colour`, `suitable_for`, `size`, `description`. Copy the generated download URL. In the repo, add it under Settings → Secrets and variables → Actions as a secret named `AWIN_FEED_URLS` (one URL per line if you have several). Don't commit the URL: it contains your API key.

## Adding another brand shop

If a brand's site runs on Shopify, `https://<shop>/meta.json` returns its name and currency. When the currency is `EUR`, add an entry to `feeds.config.json`:

```json
{ "type": "shopify", "shop": "BRAND", "brand": "Brand", "baseUrl": "https://shop.example", "styles": ["streetwear"], "tag": "Short label", "maxItems": 30 }
```

`styles` uses the page's style keys: `streetwear`, `retro`, `sport`, `skate`, `utility`, `boho`, `statement`, `minimal`. If the shop's `robots.txt` asks for a crawl delay, set `delayMs` to match. For shops whose titles put the noun first (French: "Veste en denim"), set `"nounFirst": true`. If a shop encodes men's/women's in its product handles or tags rather than in words, add `departmentHints` (see the A.P.C. entry).

To take only some brands from a multi-brand shop, read just its brand collections with `collections` and filter by the product's vendor with `vendors`, as the Asphaltgold entry does for Nike and Jordan.

Check each shop's terms before listing it, and keep the request rate low. The defaults make one request every 1.5 seconds, once a day.
