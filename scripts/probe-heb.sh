#!/usr/bin/env bash
# Read-only check of where H-E-B weekly sale data can be found. Prints a summary only.
set -u
ZIP=77437
UA="Mozilla/5.0 (compatible; Chuckwagon/0.1)"
echo "== Flipp item search (H-E-B items near $ZIP) =="
for q in chicken "ground beef" avocado cheese; do
  curl -s -m 30 -A "$UA" "https://backflipp.wishabi.com/flipp/items/search?locale=en-us&postal_code=$ZIP&q=$(echo $q | sed 's/ /%20/g')" -o flipp.json -w "q=$q http=%{http_code}\n"
  python3 - <<'PY'
import json
try:
    d=json.load(open("flipp.json"))
except Exception as e:
    print("  not json", e); raise SystemExit
items=d.get("items",[])
from collections import Counter
print("  merchants:", Counter(i.get("merchant_name") for i in items).most_common(12))
for i in [i for i in items if "H-E-B" in (i.get("merchant_name") or "") or "HEB" in (i.get("merchant_name") or "")][:4]:
    print("  ", {k:i.get(k) for k in ["name","current_price","pre_price_text","post_price_text","sale_story","valid_from","valid_to","flyer_id"]})
PY
done
echo "== Flipp flyers near $ZIP =="
curl -s -m 30 -A "$UA" "https://backflipp.wishabi.com/flipp/flyers?locale=en-us&postal_code=$ZIP" -o flyers.json -w "http=%{http_code}\n"
python3 -c "
import json
d=json.load(open('flyers.json')); f=d if isinstance(d,list) else d.get('flyers',[])
print(len(f),'flyers'); [print('  ',x.get('id'),x.get('merchant'),x.get('name'),x.get('valid_from'),x.get('valid_to')) for x in f if any(s in (x.get('merchant') or '') for s in ['H-E-B','HEB','Kroger','Walmart','Aldi','Target'])]
" 2>&1 | head -20
echo "== heb.com reachability =="
for u in https://www.heb.com/ https://www.heb.com/weekly-ad https://publications.heb.com/; do
  curl -s -m 30 -A "$UA" -o /dev/null -w "$u http=%{http_code}\n" "$u"
done
echo "== H-E-B flyer items =="
FID=$(python3 -c "
import json; d=json.load(open('flyers.json')); f=d if isinstance(d,list) else d.get('flyers',[])
h=[x for x in f if x.get('merchant')=='H-E-B']; h.sort(key=lambda x:x.get('valid_from')); print(h[-1]['id'])")
for path in "flipp/flyers/$FID?locale=en-us" "flipp/flyers/$FID/flyer_items?locale=en-us"; do
  curl -s -m 30 -A "$UA" "https://backflipp.wishabi.com/$path" -o fi.json -w "$path http=%{http_code}\n"
  python3 - <<'PY'
import json
try: d=json.load(open("fi.json"))
except Exception as e: print("  not json"); raise SystemExit
items=d if isinstance(d,list) else d.get("items") or d.get("flyer_items") or []
print("  top keys:", list(d.keys())[:20] if isinstance(d,dict) else "list", "items:", len(items))
if items:
    print("  item keys:", sorted(items[0].keys()))
    for i in items[:6]: print("   ", json.dumps(i)[:400])
    from collections import Counter
    for k in ["category","_L1","_L2","item_type"]:
        if k in items[0]: print("  ", k, Counter(i.get(k) for i in items).most_common(25))
PY
done
