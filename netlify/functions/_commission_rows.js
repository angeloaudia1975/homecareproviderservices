// MI — server copy of the Commission Report Import page readers (src/admin/import-commissions.html), so a registered
// commission statement is read on the server EXACTLY as the page reads it when Angelo imports by hand (CLAUDE.md §18,
// OPERATIONAL ACTIVATION 2026-10-13). The block between the BEGIN/END markers is copied VERBATIM from the page —
// never edit it by hand: change the page, then run  node test/commission-rows.extract.js  to refresh it.
// test/commission-rows.test.js fails whenever the page and this copy differ.
//
// What runs unattended (anything else is an exception for a person — nothing is guessed):
//   * Access4U     — the grouped QuickBooks ledger reader (parseGrouped), first sheet
//   * Ohio Medical — the two-tab open/paid reader (parseGce)
//   * any other manufacturer — ONLY its saved column template (app_settings ctpl:<slug>), and only when every saved
//     column is present in one header row and the template maps the dealer, sales amount and commission columns.
//     The page's "light auto-guess" is never used here.
//   * PDF statements and body-only (.eml) reports are not read here (Strongback SR032 PDFs are statement evidence,
//     read by _contract_commission.js).
const XLSX = require("xlsx");

/* BEGIN verbatim page readers */
const numv=v=>{ if(v==null||v==="") return null; const n=Number(String(v).replace(/[$,\s]/g,"")); return isFinite(n)?n:null; };
const FIELDS=[
  {k:"customer_name",label:"Dealer / customer name",req:true},
  {k:"customer_ref",label:"Account number"},
  {k:"ship_name",label:"Ship-to name (branch / consignee)"},
  {k:"ship_address",label:"Ship-to address"},
  {k:"ship_zip",label:"Ship-to ZIP (branch match key)"},
  {k:"ship_city",label:"Ship-to city"},
  {k:"ship_state",label:"Ship-to state"},
  {k:"product_code",label:"Product code / model"},
  {k:"product_name",label:"Product / description"},
  {k:"item_no",label:"Item / configured SKU"},
  {k:"qty",label:"Quantity"},
  {k:"amount",label:"Sales amount ($)",req:true},
  {k:"commission",label:"Commission ($)",req:true},
  {k:"commission_rate",label:"Commission rate"},
  {k:"cost",label:"Cost ($)"},
  {k:"order_date",label:"Order date"},
  {k:"line_type",label:"Line type (I / C)"},
  {k:"credit_reason",label:"Credit reason"},
  {k:"invoice_no",label:"Invoice #"},
  {k:"rep_name",label:"Rep name"},
];
const GROUPED_LINES=new Set(["access4u"]);
const A4U_PO=/\bPO\s*#?\s*\d+/i, A4U_RREF=/R-?\d+/i;
function parseGrouped(RAW){
  let hdr=-1,H=null;
  for(let i=0;i<RAW.length;i++){ const v=(RAW[i]||[]).map(x=>String(x==null?"":x).trim().toLowerCase());
    if(v.indexOf("date")>=0 && v.indexOf("commission")>=0){ hdr=i; H=RAW[i]; break; } }
  if(hdr<0) return [];
  const col={}; H.forEach((h,j)=>{ const k=String(h==null?"":h).trim().toLowerCase(); if(k) col[k]=j; });
  const cD=col["date"], cT=(col["type"]!=null?col["type"]:col["transaction type"]), cN=col["num"],
        cM=col["memo/description"], cA=col["amount"], cNet=col["net sale"], cP=col["%"], cC=col["commission"];
  const cR=(cC!=null)?cC+1:null; const T=v=>String(v==null?"":v).trim();
  const out=[]; let cur="";
  for(let i=hdr+1;i<RAW.length;i++){
    const r=RAW[i]||[]; const c0=T(r[0]); const dt=(cD!=null)?T(r[cD]):"";
    if(c0 && !dt){ const lc=c0.toLowerCase(); if(lc.indexOf("total for")===0||lc.indexOf("homecare provider s")===0) continue; cur=c0; continue; }
    if(!dt) continue;
    let client=cur; const lc0=c0.toLowerCase();
    if(c0 && lc0.indexOf("total")!==0 && lc0.indexOf("homecare provider s")!==0) client=c0;
    if(!client) continue;
    const typ=(cT!=null?T(r[cT]):"").toLowerCase(); if(typ!=="invoice" && typ!=="payment") continue;
    const memo=(cM!=null)?T(r[cM]):""; const num=(cN!=null)?T(r[cN]).toUpperCase():"";
    const amt=(cA!=null)?numv(r[cA]):null, net=(cNet!=null)?numv(r[cNet]):null,
          pct=(cP!=null)?numv(r[cP]):null, comm=(cC!=null)?numv(r[cC]):null, rep=(cR!=null)?T(r[cR]):"";
    if(typ==="payment"){ const mm=memo.match(A4U_RREF); const inv=mm?mm[0].toUpperCase():num;
      out.push({customer_name:client,customer_ref:client,line_type:"payment",amount:(net!=null?net:amt),commission:comm,commission_rate:pct,invoice_no:inv,order_date:dt,memo,rep_name:rep}); }
    else { out.push({customer_name:client,customer_ref:client,line_type:"invoice",amount:null,billed_amount:amt,commission:null,commission_rate:pct,invoice_no:num,order_date:dt,memo,rep_name:rep}); }
  }
  return out;
}
const LEDGER_TWO_TAB=new Set(["ohio-medical"]);
function parseGce(wb){
  if(!wb) return [];
  const out=[];
  const norm=s=>String(s==null?"":s).trim().toLowerCase().replace(/\s+/g," ");
  const readSheet=(sheetName, lineType)=>{
    const ws=wb.Sheets[sheetName]; if(!ws) return;
    const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:"",raw:false});
    let hr=-1;
    for(let i=0;i<Math.min(rows.length,10);i++){ const v=(rows[i]||[]).map(norm); if(v.includes("customer name") && v.some(x=>x==="cust #"||x==="cust#"||x.indexOf("cust")===0)){ hr=i; break; } }
    if(hr<0) return;
    const H=(rows[hr]||[]).map(x=>String(x==null?"":x)); const col={}; H.forEach((h,j)=>{ const k=norm(h); if(k&&col[k]==null) col[k]=j; });
    const pick=(r,...keys)=>{ for(const k of keys){ const j=col[norm(k)]; if(j!=null && r[j]!=null && String(r[j]).trim()!=="") return r[j]; } return ""; };
    for(let i=hr+1;i<rows.length;i++){ const r=rows[i]||[];
      const cn=String(pick(r,"customer name")).trim(); if(!cn) continue;
      const sales=pick(r,"sales $","sales$");
      const addr=[pick(r,"address1","address 1"),pick(r,"address 2","address2"),pick(r,"address 3","address3")].map(function(x){return String(x||"").trim();}).filter(Boolean).join(", ");
      const rec={ customer_name:cn, customer_ref:String(pick(r,"cust #","cust#","cust")).trim(),
        ship_name:String(pick(r,"ship to name","ship-to name","shipto name")).trim(), ship_address:addr,
        ship_city:pick(r,"city"), ship_state:pick(r,"state"), ship_zip:pick(r,"zip"),
        product_code:pick(r,"part number"), product_name:pick(r,"part description"), qty:pick(r,"quantity","qty"),
        commission_rate:pick(r,"comm %","comm  %","comm%"), order_date:pick(r,"order date","invoice date"),
        invoice_no:String(pick(r,"inv number","invoice number","inv #")).trim(), rep_name:pick(r,"sales rep"), line_type:lineType };
      if(lineType==="invoice"){
        if(String(pick(r,"invoice paid")).trim().toLowerCase()==="yes") continue;   // open pipeline only
        rec.billed_amount=sales; rec.amount=null; rec.commission=null;
      } else { rec.amount=sales; rec.commission=pick(r,"earned commission $","earned commission"); }
      out.push(rec);
    }
  };
  readSheet("Sales-Commission Data","invoice");   // open / invoiced pipeline (unpaid)
  readSheet("Current month payment","payment");   // paid this month → rep payout
  return out;
}
/* END verbatim page readers */

// The page reads the FIRST sheet as rows of formatted text (sheet_to_json header:1, defval "", raw:false).
function readWorkbook(bytes) {
  const wb = XLSX.read(bytes, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return { wb, RAW: XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false }) };
}

// A saved template applied the page's way (header text -> column), but strict: every saved column must be found in ONE
// header row (the first 25 rows are searched), and dealer / sales amount / commission must be mapped.
const REQUIRED = ["customer_name", "amount", "commission"];
function mapByTemplate(RAW, tpl) {
  const want = FIELDS.filter(f => tpl && tpl[f.k]).map(f => [f.k, String(tpl[f.k])]);
  if (!want.length) return { error: "no_template", message: "No saved column mapping for this manufacturer. Import one statement by hand in Commission Report Import and save the mapping; later statements then process automatically." };
  const missingReq = REQUIRED.filter(k => !want.some(([w]) => w === k));
  if (missingReq.length) return { error: "template_incomplete", message: "The saved column mapping does not map: " + missingReq.join(", ") + "." };
  for (let hr = 0; hr < Math.min(RAW.length, 25); hr++) {
    const HEADERS = (RAW[hr] || []).map((h, i) => String(h || "").trim() || ("Column " + (i + 1)));
    if (!want.every(([, h]) => HEADERS.includes(h))) continue;
    const MAP = Object.fromEntries(want);
    const idx = {}; FIELDS.forEach(f => { idx[f.k] = MAP[f.k] ? HEADERS.indexOf(MAP[f.k]) : -1; });
    const rows = RAW.slice(hr + 1).map(r => { const o = {}; FIELDS.forEach(f => { if (idx[f.k] >= 0) o[f.k] = r[idx[f.k]]; }); return o; })
      .filter(o => String(o.customer_name || "").trim());
    return { rows, header_row: hr + 1, mapped_fields: Object.keys(MAP) };
  }
  return { error: "template_does_not_fit", message: "The saved column mapping does not fit this file: its columns were not all found in one header row." };
}

// bytes + file extension + manufacturer -> { rows, ledger, mapped_fields, reader } or { error, message }.
function readStatement(bytes, ext, slug, tpl) {
  const x = String(ext || "").toLowerCase();
  if (x === "pdf") return { error: "pdf_statement", message: "PDF statements are not read automatically. Import this one by hand in Commission Report Import." };
  if (x === "eml") return { error: "body_report", message: "This statement is in the email body. Enter it by hand in Commission Report Import." };
  if (!["xlsx", "xls", "csv"].includes(x)) return { error: "unsupported_format", message: "Unsupported file type ." + x + "." };
  let book; try { book = readWorkbook(bytes); } catch (e) { return { error: "unreadable", message: String(e.message || e).slice(0, 200) }; }
  if (LEDGER_TWO_TAB.has(slug)) {
    const rows = parseGce(book.wb);
    return rows.length ? { rows, ledger: true, mapped_fields: [], reader: "two_tab_ledger" }
      : { error: "no_rows", message: "The two-tab ledger reader found no lines (sheets \"Sales-Commission Data\" / \"Current month payment\")." };
  }
  if (GROUPED_LINES.has(slug)) {
    const rows = parseGrouped(book.RAW);
    return rows.length ? { rows, ledger: true, mapped_fields: [], reader: "grouped_ledger" }
      : { error: "no_rows", message: "The grouped ledger reader found no Invoice / Payment lines." };
  }
  const m = mapByTemplate(book.RAW, tpl);
  if (m.error) return m;
  if (!m.rows.length) return { error: "no_rows", message: "No dealer lines were found under the mapped header row." };
  return { rows: m.rows, ledger: false, mapped_fields: m.mapped_fields, reader: "template", header_row: m.header_row };
}

module.exports = { readStatement, mapByTemplate, readWorkbook, parseGrouped, parseGce, FIELDS, GROUPED_LINES, LEDGER_TWO_TAB, numv };
