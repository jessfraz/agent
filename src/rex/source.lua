-- Agent Messages reads run under Rex Server's macOS permission identity.
-- One bounded, read-only job slot; no sessions, terminals, or persistent queue.
local job = nil
local maximum = 32 * 1024 * 1024
local chunk_size = 64 * 1024

rex.action{
  name = "agent_messages_start",
  title = "Beep Boop: start a Messages read",
  args = { id = "string", program = "string", argv = "array", path = "string", timeout_seconds = "integer" },
  run = function(_, args)
    if job and job.cancelled and not job.handle:running() then job = nil end
    if job and job.id == args.id then return { state = "started", id = job.id } end
    -- Keep a completed capture until its owner releases it. A vanished owner
    -- cannot reserve the slot forever after the helper's own deadline.
    if job and (job.handle:running() or os.time() < job.expires) then return { state = "busy" } end
    if args.timeout_seconds < 1 or args.timeout_seconds > 65535 then error("Invalid Messages timeout") end
    local next_job = { id = args.id, parts = {}, bytes = 0, overflow = false,
      expires = os.time() + args.timeout_seconds + 30 }
    local command = { args.program, "messages-read", "--" }
    for _, arg in ipairs(args.argv) do
      if type(arg) ~= "string" then error("Messages arguments must be strings") end
      command[#command + 1] = arg
    end
    local handle, err = rex.exec.start(command, {
      cwd = "/", env = { PATH = args.path }, detach = true, timeout = args.timeout_seconds + 15,
      stderr = false,
      stdout = function(data)
        if next_job.bytes + #data > maximum then
          next_job.overflow = true
          if next_job.handle then next_job.handle:kill("SIGTERM") end
          return
        end
        next_job.parts[#next_job.parts + 1] = data
        next_job.bytes = next_job.bytes + #data
      end,
    })
    if not handle then error(err or "Messages helper could not start") end
    next_job.handle = handle
    job = next_job
    return { state = "started", id = job.id }
  end,
}

rex.action{
  name = "agent_messages_read",
  title = "Beep Boop: collect a Messages read",
  args = { id = "string", offset = "integer" },
  run = function(_, args)
    if not job or job.id ~= args.id then return { state = "missing" } end
    if not job.output then
      local result, err = job.handle:wait(0.05)
      if not result and err == "timeout" then return { state = "running", id = job.id } end
      if not result then error(err or "Messages helper exit is unavailable") end
      job.code = result.code
      job.output = table.concat(job.parts)
      job.parts = nil
    end
    local start = args.offset
    if start < 0 or start > #job.output then error("Invalid Messages output offset") end
    local finish = math.min(start + chunk_size, #job.output)
    -- Lua strings use bytes. Keep a UTF-8 character in the same JSON chunk.
    while finish < #job.output do
      local byte = string.byte(job.output, finish + 1)
      if byte < 128 or byte >= 192 then break end
      finish = finish - 1
    end
    return {
      state = "finished", id = job.id, code = job.code,
      chunk = string.sub(job.output, start + 1, finish),
      next_offset = finish, total_bytes = #job.output, overflow = job.overflow,
    }
  end,
}

rex.action{
  name = "agent_messages_cancel",
  title = "Beep Boop: stop a Messages read",
  args = { id = "string" },
  run = function(_, args)
    if job and job.id == args.id then
      job.cancelled = true
      if job.handle:running() then job.handle:kill("SIGTERM")
      else job = nil end
    end
    return { id = args.id }
  end,
}
