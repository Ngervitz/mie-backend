const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const env = require('../config/env');

const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  realtime: {
    transport: ws,
  },
});

module.exports = supabase;
