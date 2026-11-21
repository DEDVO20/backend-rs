import { supabase } from './supabase.js'

export async function findAuthAccount(email: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('find_auth_account', { p_email: email })
  if (error) throw error
  return data
}
