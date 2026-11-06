#!/usr/bin/env python3
"""C3-07 Stage 5 — builds netlify/functions/_app_forms_layout.json: where each answer is written on a FLAT manufacturer
application PDF (one with no fillable fields), resolved from the printed labels so a value starts just after its label
and stops before the next one. Run after replacing a form, then render the filled samples and look at them:
    python3 scripts/app-forms-layout.py
Coordinates are PDF points with the origin at the TOP-LEFT of the page (pdfplumber), page numbers from 1. """
import json, os, sys, hashlib
import pdfplumber

ROOT = os.path.join(os.path.dirname(__file__), '..')
DOCS = os.path.join(ROOT, 'src', 'assets', 'docs')

# key, page, approximate top of the label line, label word, approximate x0 of that word, x where the value must stop
SPEC = {
  'access4u': ('credit-application-for-access4u-2023-ms4v7utn.pdf', [
    ('biz.legal_name', 1, 62, 'Name:', 73, 570), ('biz.address', 1, 81, 'Address:', 63, 330), ('biz.city', 1, 81, 'City:', 334, 458),
    ('biz.state', 1, 81, 'State:', 462, 510), ('biz.zip', 1, 81, 'Zip:', 514, 576), ('biz.phone', 1, 100, 'Phone:', 36, 192),
    ('biz.fax', 1, 100, 'Fax:', 196, 340), ('biz.ein', 1, 100, 'ID:', 391, 576),
    ('ship.address', 1, 121, 'Address:', 71, 310), ('ship.city', 1, 121, 'City:', 314, 463), ('ship.state', 1, 121, 'State:', 467, 511), ('ship.zip', 1, 121, 'Zip:', 515, 576),
    ('biz.resale_no', 1, 142, '#', 99, 233), ('biz.years', 1, 142, 'business', 433, 576),
    ('biz.started', 1, 163, 'Started:', 89, 200), ('biz.nature', 1, 163, 'business:', 240, 576),
    ('purch.name', 1, 225, 'Manager:', 78, 290), ('purch.email', 1, 225, 'Email:', 295, 463), ('purch.phone', 1, 225, 'Phone:', 467, 576),
    ('ap.name', 1, 243, 'Name:', 106, 287), ('ap.email', 1, 243, 'Email:', 291, 465), ('ap.phone', 1, 243, 'Phone:', 469, 576),
    ('bank.name', 1, 298, 'Name:', 57, 262), ('bank.phone', 1, 298, 'Phone:', 433, 576),
    ('bank.address', 1, 316, 'Address:', 36, 269), ('bank.city', 1, 316, 'City:', 273, 435), ('bank.state', 1, 316, 'State:', 439, 483), ('bank.zip', 1, 316, 'Zip:', 487, 576),
    ('ref1.name', 1, 353, 'Name:', 106, 351), ('ref1.phone', 1, 353, 'Phone:', 355, 576), ('ref1.contact', 1, 371, 'Name:', 102, 352), ('ref1.fax', 1, 371, 'Fax:', 356, 576),
    ('ref2.name', 1, 390, 'Name:', 106, 351), ('ref2.phone', 1, 390, 'Phone:', 355, 576), ('ref2.contact', 1, 408, 'Name:', 102, 352), ('ref2.fax', 1, 408, 'Fax:', 356, 576),
    ('ref3.name', 1, 427, 'Name:', 106, 351), ('ref3.phone', 1, 427, 'Phone:', 355, 576), ('ref3.contact', 1, 445, 'Name:', 102, 352), ('ref3.fax', 1, 445, 'Fax:', 356, 576),
    ('owner1.name', 1, 486, 'Name:', 36, 207), ('owner1.title', 1, 486, 'Title:', 211, 338), ('owner1.email', 1, 486, 'Email:', 342, 475), ('owner1.phone', 1, 486, 'Phone:', 479, 576),
    ('owner2.name', 1, 507, 'Name:', 36, 207), ('owner2.title', 1, 507, 'Title:', 211, 338), ('owner2.email', 1, 507, 'Email:', 342, 475), ('owner2.phone', 1, 507, 'Phone:', 479, 576),
  ]),
  'ovation-medical': ('ovation-medical-new-customer-credit-application-rev-082017-mw3ttkj5.pdf', [
    ('biz.legal_name', 1, 187, 'Name', 73, 395), ('biz.phone', 1, 187, 'Phone', 398, 576), ('biz.full_address', 1, 202, 'Address', 73, 576),
    ('biz.years', 1, 218, 'Long', 56, 143), ('biz.annual_volume', 1, 234, 'Sales', 103, 179), ('biz.sales_area', 1, 234, 'Area', 204, 322),
    ('owner1.name', 1, 280, 'Name', 36, 143), ('owner1.title', 1, 280, 'Title', 146, 215), ('owner1.address', 1, 280, 'Address', 218, 358), ('owner1.phone', 1, 280, 'Phone', 362, 466),
    ('owner2.name', 1, 296, 'Name', 36, 143), ('owner2.title', 1, 296, 'Title', 146, 215), ('owner2.address', 1, 296, 'Address', 218, 358), ('owner2.phone', 1, 296, 'Phone', 362, 466),
    ('ref1.name', 1, 358, 'Name', 36, 143), ('ref1.full_address', 1, 358, 'Address', 146, 322), ('ref1.phone', 1, 358, 'Phone', 326, 430), ('ref1.contact', 1, 358, 'Contact', 434, 576),
    ('ref2.name', 1, 373, 'Name', 36, 143), ('ref2.full_address', 1, 373, 'Address', 146, 322), ('ref2.phone', 1, 373, 'Phone', 326, 430), ('ref2.contact', 1, 373, 'Contact', 434, 576),
    ('ref3.name', 1, 389, 'Name', 36, 143), ('ref3.full_address', 1, 389, 'Address', 146, 322), ('ref3.phone', 1, 389, 'Phone', 326, 430), ('ref3.contact', 1, 389, 'Contact', 434, 576),
    ('bank.name', 1, 513, 'Bank', 36, 215), ('bank.full_address', 1, 513, 'Address', 218, 430), ('bank.phone', 1, 513, 'Phone', 434, 576),
    ('bank.contact', 1, 529, 'Name', 57, 215),
  ]),
}

def resolve(pdf, page, top, word, x0):
    pg = pdf.pages[page - 1]
    best = None
    for w in pg.extract_words():
        if w['text'] != word: continue
        d = abs(w['top'] - top) + abs(w['x0'] - x0)
        if abs(w['top'] - top) <= 5 and abs(w['x0'] - x0) <= 8 and (best is None or d < best[0]): best = (d, w)
    if not best: raise SystemExit(f'label not found: p{page} {word!r} near ({x0},{top})')
    return best[1]

out = {}
for key, (fname, spec) in SPEC.items():
    path = os.path.join(DOCS, fname)
    sha = hashlib.sha256(open(path, 'rb').read()).hexdigest()
    with pdfplumber.open(path) as pdf:
        items = []
        for k, page, top, word, x0, until in spec:
            w = resolve(pdf, page, top, word, x0)
            x = round(w['x1'] + 4, 1)
            items.append({'key': k, 'page': page, 'x': x, 'baseline': round(w['bottom'] - 1, 1), 'w': round(until - x - 3, 1)})
        out[key] = {'file': fname, 'sha256': sha, 'height': float(pdf.pages[0].height), 'text': items}
json.dump(out, open(os.path.join(ROOT, 'netlify', 'functions', '_app_forms_layout.json'), 'w'), indent=1)
print('ok', {k: len(v['text']) for k, v in out.items()})
