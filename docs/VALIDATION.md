# Blind validation: four UK waterbodies

Predictions recorded **before** running the probe, so the comparison is honest.
They come from general geological knowledge, not from a lookup — the build
environment has no network access. That is the point: if the app's inference
matches an independent prior, both are more trustworthy; where they diverge,
one of them is wrong and we find out which.

Committed before the probe was run. Check the git history if you want to
confirm that.

---

## The four, and why these four

Chosen to be geologically unambiguous and to span the range the app has to cope
with — not to be easy.

| # | Site | Why chosen |
|---|---|---|
| 1 | **River Test at Romsey, Hampshire** | The archetypal chalk stream. If the app cannot get this right, nothing else matters. |
| 2 | **River Tees at Middleton-in-Teesdale, Co. Durham** | Hard impermeable upland with peat headwaters — the opposite extreme. |
| 3 | **Great Ouse at Bedford** | Jurassic clay under heavy arable — the "fines from farmland" case. |
| 4 | **River Spey at Boat of Garten, Highland** | **The interesting one.** Bedrock and superficial deposits should *disagree*. |

---

## 1. River Test at Romsey, Hampshire

**Expected geology.** Chalk — the Seaford/Newhaven/Lewes Nodular Chalk
formations of the White Chalk Subgroup. Valley floor almost certainly alluvium,
very possibly with peat, since Test valley wetlands are well known.

**Expected NRFA.** High-permeability bedrock near 1.0. BFIHOST very high, I would
say **0.90–0.98** — chalk streams are the most groundwater-dominated rivers in
Britain. Low arable in the valley, more on the downs.

**Expected app output:** `sand` or `mixed_mineral`, medium confidence.

**Physical reality, and where I expect the app to be crudely right but subtly
wrong.** A chalk stream runs exceptionally clear. Suspended solids are very low
most of the year, and what there is tends to be fine carbonate and diatoms, not
sand. The app's chalk rule scores coarseness 0.0, but a very high BFI will push
the result coarse. **I expect the app to say something coarser than reality.**
That is a real limitation and I would rather predict it than explain it away
afterwards.

---

## 2. River Tees at Middleton-in-Teesdale, Co. Durham

**Expected geology.** Carboniferous — limestone, sandstone and mudstone of the
Alston Formation / Yoredale facies, intruded by the **Whin Sill** dolerite.
Superficial: till, and blanket peat over the moorland headwaters.

**Expected NRFA.** Low-permeability bedrock dominant, perhaps 0.7–0.9. BFIHOST
**low, 0.30–0.45** — this is a famously flashy moorland river. Arable near zero;
mountain/heath/bog high. High SAAR, likely **1200–1800 mm**.

**Expected app output:** `silt` or `clay`, and I would expect low-to-medium
confidence.

**Physical reality.** Flashy peat-and-moorland rivers carry a lot of fine
organic-stained material on the rising limb, plus coarse bedload from the
steep channel. The suspended fraction is fine. The app should get the
direction right.

---

## 3. Great Ouse at Bedford

**Expected geology.** Jurassic mudstones — Oxford Clay, Kellaways, possibly
Ampthill Clay; Oolite limestones further upstream. Superficial: till, river
terrace gravels and alluvium.

**Expected NRFA.** Low-permeability bedrock dominant. BFIHOST **middling,
0.45–0.65**. **Arable high, 0.55–0.75** — this is intensive East Anglian arable.
SAAR low, **550–650 mm**, one of the driest parts of Britain.

**Expected app output:** `clay`. Both the impermeable bedrock rule and the
arable rule push the same way, so this should be the app's most confident fine
answer.

**Physical reality.** Heavy fine sediment load from field runoff. Genuinely poor
prospects for hydrocyclone pre-treatment — the fines that dominate fouling are
exactly what a cyclone cannot remove. This site *should* come out unattractive,
and if it does not, the screening logic is wrong.

---

## 4. River Spey at Boat of Garten, Highland — the interesting one

**Expected geology.** Bedrock: Dalradian metamorphics — schist, psammite,
quartzite — plus Cairngorm **granite** in the headwaters. Superficial:
extensive **glaciofluvial sand and gravel**, this being a classic glaciated
Highland valley.

**Expected NRFA.** Bedrock low-permeability (crystalline rock is classed low
regardless of how coarse its weathering products are). Superficial permeability
**high**, from the sand and gravel. BFIHOST moderate, **0.55–0.75** — the
glaciofluvial aquifer supports baseflow. Arable near zero. SAAR high.

**Expected app output:** here is the test. NRFA bedrock says *impermeable →
fine*. BGS superficial says *sand and gravel → coarse*. **They should
disagree**, and the app should say so and drop confidence, rather than
averaging them into a bland middle.

**Physical reality.** The Spey is a famously sandy, gravelly river — coarse
bedload, granitic sand. The *superficial* reading is the physically correct one
here, and the bedrock permeability class is misleading, because "low
permeability" describes water movement through rock, not the grain size of what
that rock weathers to.

**This is the most valuable of the four**, because it is where I expect the app's
current weighting to be wrong. NRFA drives and BGS only corroborates — but here
BGS is right and NRFA is misleading. If that is what we see, the weighting
needs changing, and it is better to find it on a known river than on a real
site.

---

## Summary table — predictions before the run

| Site | Bedrock | BFIHOST | Arable | Predicted output | Confidence in my own prediction |
|---|---|---|---|---|---|
| Test, Romsey | Chalk, high perm | 0.90–0.98 | low | sand / mixed | High on geology, high on BFI |
| Tees, Middleton | Carboniferous + dolerite, low perm | 0.30–0.45 | ~0 | silt / clay | High |
| Great Ouse, Bedford | Jurassic clay, low perm | 0.45–0.65 | 0.55–0.75 | clay | High |
| Spey, Boat of Garten | Dalradian + granite, low perm | 0.55–0.75 | ~0 | **conflict expected** | High on geology, unsure what the app will do |

## Two predictions about the app itself, not the geology

1. **The Test will come out coarser than it should.** A very high BFI pushes the
   result coarse, but a chalk stream's actual suspended load is fine carbonate.
2. **The Spey will expose the NRFA-drives/BGS-corroborates weighting.**
   Permeability is not grain size, and for crystalline rock the two come apart.

If either of those turns out to be right, the fix is in the inference, not in
the data.
