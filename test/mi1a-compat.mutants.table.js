/* MI-1a compatibility mutants — each must make test/mi1a-compat.test.js fail. */
module.exports = {
  'route: not enrolled goes to v2':            { file: '_mi1a.js', from: 'return isEnrolled ? (flagOn ? "v2" : "paused") : "legacy";', to: 'return flagOn ? "v2" : (isEnrolled ? "paused" : "legacy");' },
  'route: enrolled + switch off writes legacy': { file: '_mi1a.js', from: 'return isEnrolled ? (flagOn ? "v2" : "paused") : "legacy";', to: 'return isEnrolled && flagOn ? "v2" : "legacy";' },
  'commission: sales switch turns commission v2 on': { file: 'commissions-api.js', from: 'MI.routeCommission(await flagOn(sbGet,"mi_commission_v2"), await miI.enrolled(slug,"commission"))', to: 'MI.routeCommission(await flagOn(sbGet,"mi_import_v2"), await miI.enrolled(slug,"commission"))' },
  'enrolment: unreadable treated as not enrolled': { file: '_mi1a.js', from: '      if(NOT_INSTALLED.test(String(e && e.message || e))) return false;\n      throw e;', to: '      return false;' },
  'enrolment: wildcard ignored':               { file: '_mi1a.js', from: 'manufacturer=in.(${encodeURIComponent(s)},*)', to: 'manufacturer=eq.${encodeURIComponent(s)}' },
  'commission: deletes sales-report rows again': { file: 'commissions-api.js', from: '&or=(source.eq.commission,and(source.is.null,external_ref.is.null))`;', to: '`;' },
  'commission: back to "every source but sales_report"': { file: 'commissions-api.js', from: '&or=(source.eq.commission,and(source.is.null,external_ref.is.null))`;', to: '&or=(source.is.null,source.neq.sales_report)`;' },
  'commission: deletes null-source rows that carry an external_ref': { file: 'commissions-api.js', from: 'and(source.is.null,external_ref.is.null)', to: 'source.is.null' },
  'commission: failed delete swallowed':        { file: 'commissions-api.js', from: 'catch(e){ return json(502,{ok:false,error:"replace_failed",', to: 'catch(e){ if(0) return json(502,{ok:false,error:"replace_failed",' },
  'commission v2: one call per month':          { file: 'commissions-api.js', from: '    months, decisions:(b.decisions&&typeof b.decisions==="object")?b.decisions:{},', to: '    months:months.slice(0,1), decisions:(b.decisions&&typeof b.decisions==="object")?b.decisions:{},' },
  'alias guard removed':                        { file: 'sales-import-api.js', from: 'if(cur && cur.dealer_id && cur.dealer_id!==dealer_id && b.replace!==true){', to: 'if(false){' },
  'v2: browser key passed through':             { file: 'sales-import-api.js', from: '    delete rec.external_ref; rec.rep_name=repOf(dealer_id);', to: '    rec.rep_name=repOf(dealer_id);' },
  'v2: approval dropped':                       { file: 'sales-import-api.js', from: 'approve_paid:b.approve_paid===true, approve_reason:clean(b.approve_reason,500)||"",', to: 'approve_paid:false, approve_reason:"",' },
  'v2: refusal reported as success':            { file: 'sales-import-api.js', from: 'if(!r.ok) return json(409,{ok:false,refused:true,error:r.code,message:r.message});\n  const v2=r.result||{};', to: 'const v2=r.result||{};' },
};
