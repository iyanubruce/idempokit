export const CHECK_AND_LOCK = `
  local key = KEYS[1]
  local lock_ttl = tonumber(ARGV[1])
  local now = ARGV[2]

  local stored = redis.call('GET', key)
  if stored then
    -- ✅ SAFE DECODE: pcall catches JSON parse errors
    local success, data = pcall(cjson.decode, stored)
    if not success or type(data) ~= 'table' or not data.status then
      -- Corrupted/invalid data → treat as available
      return cjson.encode({status='acquired'})
    end

    if data.status == 'processing' then
      return cjson.encode({status='locked'})
    else
      return cjson.encode({
        status='exists',
        fingerprint=data.fingerprint or '',
        result=data.result,
        createdAt=data.createdAt or now
      })
    end
  end

  local lock_data = cjson.encode({
    status='processing',
    lockAcquiredAt=now
  })
  
  local ok = redis.call('SET', key, lock_data, 'PX', lock_ttl, 'NX')
  if ok then 
    return cjson.encode({status='acquired'}) 
  else
    return cjson.encode({status='locked'})
  end
`;

export const COMMIT_RESULT = `
  local key = KEYS[1]
  local fingerprint = ARGV[1]
  local result_json = ARGV[2]
  local retention_ms = tonumber(ARGV[3])
  local now = ARGV[4]

  -- Get current value to verify we still hold the lock
  local stored = redis.call('GET', key)
  if not stored then
    return 0  -- Key expired or was deleted
  end

  local success, data = pcall(cjson.decode, stored)
  if not success or not data.status or data.status ~= 'processing' then
    return 0  -- Not in processing state (already committed or corrupted)
  end

  -- Commit final result
  local committed_data = cjson.encode({
    status = 'committed',
    fingerprint = fingerprint,
    result = cjson.decode(result_json),
    createdAt = now
  })

  redis.call('SET', key, committed_data, 'PX', retention_ms)
  return 1
`;
