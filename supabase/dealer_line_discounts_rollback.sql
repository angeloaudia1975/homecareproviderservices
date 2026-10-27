-- Rollback for dealer_line_discounts.sql. Refuses while any rate is set (a rate is a commercial decision;
-- remove them in Dealer Manager first). With the table gone, every dealer pays the line's default price.
do $$ begin
  if to_regclass('public.dealer_line_discounts') is not null and exists (select 1 from dealer_line_discounts) then
    raise exception 'dealer_line_discounts still holds rates — clear them in Dealer Manager first; nothing dropped';
  end if;
end $$;
drop table if exists dealer_line_discounts;
