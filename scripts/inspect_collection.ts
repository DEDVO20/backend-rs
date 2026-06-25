import { supabase } from '../src/lib/supabase.js'

async function main() {
  console.log("Checking collection debtors and debts in DB...")
  
  const { data: debtors, error: deErr } = await supabase
    .from('collection_debtors')
    .select('*')
    .limit(5)
  
  if (deErr) {
    console.error("Error fetching debtors:", deErr)
  } else {
    console.log("Sample Debtors:", debtors)
  }

  const { data: debts, error: deErr2 } = await supabase
    .from('collection_debts')
    .select('*')
    .limit(10)
  
  if (deErr2) {
    console.error("Error fetching debts:", deErr2)
  } else {
    console.log("Sample Debts:", debts)
  }
}

main().catch(console.error)
