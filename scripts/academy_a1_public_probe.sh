#!/usr/bin/env bash
# HCPS Academy — Phase A1 external probe. Calls every new table through the public REST API with the
# PUBLIC (anon) key, exactly as a stranger on the internet could. Every line must say BLOCKED.
# Usage: SUPABASE_URL=https://<project>.supabase.co SUPABASE_ANON_KEY=<public key> ./academy_a1_public_probe.sh
set -u
tables="academy_learners academy_memberships academy_invites academy_handoff_codes academy_courses
academy_course_versions academy_modules academy_lessons academy_questions academy_media product_facts
academy_content_refs academy_enrollments academy_progress academy_attempts academy_certificates
academy_external_certs academy_events"
fail=0
for t in $tables; do
  code=$(curl -s -o /tmp/probe.$$ -w '%{http_code}' "$SUPABASE_URL/rest/v1/$t?select=*&limit=1" \
         -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY")
  body=$(head -c 160 /tmp/probe.$$)
  if [ "$code" = "401" ] || [ "$code" = "403" ] || echo "$body" | grep -q '42501'; then echo "BLOCKED  $code  $t"
  else echo "OPEN!!   $code  $t  $body"; fail=1; fi
  # write attempt must be refused too
  wcode=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$SUPABASE_URL/rest/v1/$t" -H "apikey: $SUPABASE_ANON_KEY" \
          -H "Authorization: Bearer $SUPABASE_ANON_KEY" -H 'Content-Type: application/json' -d '{}')
  case "$wcode" in 401|403) ;; *) echo "WRITE NOT REFUSED ($wcode) $t"; fail=1;; esac
done
scode=$(curl -s -o /dev/null -w '%{http_code}' "$SUPABASE_URL/storage/v1/object/list/academy-private" -X POST \
        -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY" -H 'Content-Type: application/json' -d '{"prefix":""}')
echo "storage list academy-private with public key: HTTP $scode (expect 400/401/403/404, never 200 with files)"
pcode=$(curl -s -o /dev/null -w '%{http_code}' "$SUPABASE_URL/storage/v1/object/public/academy-private/x.pdf")
echo "public URL for academy-private: HTTP $pcode (expect 400/404)"
rm -f /tmp/probe.$$
exit $fail
