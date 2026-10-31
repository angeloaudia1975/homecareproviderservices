/* Mutants for Smart Email Learning Phase 3 part 1 (_email_rules_apply.js). Each must make its suite FAIL (CONTROL must pass).
   (No mutant for the sign-in role check: the staff_users re-check below it refuses the same cases, by design.) */
const AP = '_email_rules_apply.js';
module.exports = {
  CONTROL: { file: AP, suite: 'js3', control: true, from: 'const MAX_RULES = 12;', to: 'const MAX_RULES = 12; /* control */' },
  loose_switch: { file: AP, suite: 'js3', from: 'if(!flags || flags[SWITCH_APPLY] !== true)', to: 'if(!flags || !flags[SWITCH_APPLY])' },
  trusts_signin_role: { file: AP, suite: 'js3', from: 'if(!u || String(u.role || "").toLowerCase() !== "president" || u.active === false) return off("not_president");', to: '' },
  former_president_ok: { file: AP, suite: 'js3', from: '|| u.active === false) return off("not_president");', to: ') return off("not_president");' },
  other_types_too: { file: AP, suite: 'js3', from: 'const mine = list.filter(r => r && r.email_type === emailType)', to: 'const mine = list.filter(r => r && r.email_type !== "all")' },
  three_examples: { file: AP, suite: 'js3', from: 'const MAX_EXAMPLES = 2;', to: 'const MAX_EXAMPLES = 3;' },
  digits_ok: { file: AP, suite: 'js3', from: '  if(/\\d/.test(t.replace(/\\b\\d{1,3}%/g, ""))) return null;', to: '' },
  any_chars: { file: AP, suite: 'js3', from: 'if(!ALLOWED_TEXT.test(t) || /@/.test(t)', to: 'if(/@/.test(t)' },
  retired_kept: { file: AP, suite: 'js3', from: 'const live = rules.filter(r => Object.prototype.hasOwnProperty.call(byId, r.id));', to: 'const live = rules;' },
  throws_on_failure: { file: AP, suite: 'js3', from: '  }catch(e){ return off("unreadable"); }', to: '  }catch(e){ throw e; }' },
  no_fact_guard: { file: AP, suite: 'js3', from: '    "Never invent a name, date, time, price, product, promotion or commitment to satisfy a preference.",\n', to: '' },
};
