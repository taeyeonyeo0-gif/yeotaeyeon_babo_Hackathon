import { createClient } from '@supabase/supabase-js';

const supabaseUrl = typeof __SUPABASE_URL__ === 'string' ? __SUPABASE_URL__ : '';
const publishableKey = typeof __SUPABASE_PUBLISHABLE_KEY__ === 'string' ? __SUPABASE_PUBLISHABLE_KEY__ : '';

export const supabaseConfigured = Boolean(supabaseUrl && publishableKey);
export const supabase = supabaseConfigured
  ? createClient(supabaseUrl, publishableKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
    })
  : null;
