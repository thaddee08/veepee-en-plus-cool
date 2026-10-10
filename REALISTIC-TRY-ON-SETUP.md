# Enable realistic outfit previews

The website is hosted as a static GitHub Pages site, so it cannot safely store the FASHN API key or call the paid provider directly from the browser. The small Cloudflare Worker in `worker/` keeps the key private, checks Cloudflare Turnstile, restricts product-image hosts, and limits each IP to eight generation requests per hour. A preview applies the selected pieces one at a time to the same still image; each piece uses one FASHN Try-On Max credit at the configured fast 1K setting.

## One-time setup

1. Create a FASHN developer account, purchase API credits, and create an API key in its dashboard. Do not put the key in this repository or in `data/virtual-tryon-config.json`.
2. Create a Cloudflare account and install Wrangler (`npm install --global wrangler`), then sign in with `npx wrangler login`.
3. Create the rate-limit KV namespace from the `worker` directory with `npx wrangler kv namespace create TRYON_LIMITS`. Replace the placeholder namespace ID in `worker/wrangler.toml` with the returned ID.
4. Create a Turnstile widget for the hostname `thaddee08.github.io`. Save its public site key for step 6.
5. From `worker/`, add the private provider and Turnstile keys as Worker secrets, then deploy:

   ```sh
   npx wrangler secret put FASHN_API_KEY
   npx wrangler secret put TURNSTILE_SECRET
   npx wrangler deploy
   ```

   When prompted, paste each key into the terminal. Do not paste secrets into chat or commit them.

6. Edit `data/virtual-tryon-config.json`: set `apiBaseUrl` to the deployed Worker URL (for example, `https://restpost-virtual-try-on.<your-account>.workers.dev`) and `turnstileSiteKey` to the public key from step 4. The model image URL is the mannequin image hosted by this site.
7. Commit and push that configuration file to GitHub. Wait for Pages to deploy, then reload the site.

## What visitors see

The buyer chooses a look and presses **Generate realistic preview**. Each selected item is applied sequentially, and the final image appears in place of the rotating mannequin. The result is a generated still image, not a size-accurate fit or a rotatable 3D outfit. FASHN output is kept in the browser session; its API key stays in the Worker. The API provider receives the product image URL and the mannequin image URL, and generation consumes credits.

If a new retailer feed introduces another image host, add that exact image hostname to `ALLOWED_PRODUCT_IMAGE_HOSTS` in `worker/wrangler.toml` before enabling previews for those items.
