# 3D try-on assets

## Mannequin

- File: `human-base-rigged.glb` (4.8 MB)
- Source: [Innerscene — Human base mesh with editable 53-bone rig](https://www.innerscene.com/tools/library/3d-parts/human-base-mesh-with-editable-53-bone-rig-8e7c8ab1)
- License: CC0, as stated on the source listing.
- Model: MakeHuman/MPFB anatomical base mesh, neutral gray material, 53-bone rig, A-pose, no animation.

## Garments

The product feed currently has retailer photos and product links only. It contains no fitted garment GLB/glTF files or garment sizing/fit data. No garment 3D assets are included or implied. Add only licensed, pre-fitted garment models to `data/try-on-assets.json`, keyed to the exact product URL, with the `restpost-human-base-v1` skeleton and coordinate system.

Each entry in the manifest's `products` array uses this shape:

```json
{
  "url": "https://retailer.example/product/sku",
  "modelUrl": "assets/try-on/garments/sku.glb",
  "rigId": "restpost-human-base-v1",
  "category": "T-shirts",
  "position": [0, 0, 0],
  "rotation": [0, 0, 0],
  "scale": 1,
  "layerOrder": 10
}
```

The GLB must contain a skinned garment mesh with bone names and bind pose compatible with the mannequin. Keep the model and texture maps licensed for public website use. Variants and garment-size grading are not connected yet because the current retailer feed does not expose try-on model data or an in-page size/color selector.
