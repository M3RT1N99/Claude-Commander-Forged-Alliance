/**
 * GameFiles-free regression checks for native CMaui state semantics implemented
 * by src/engine-lua/moho.lua.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-maui-control-state.ts
 */
import { LuaFactory } from 'wasmoon'
import MOHO_LUA from '../src/engine-lua/moho.lua?raw'

let failures = 0
const check = (ok: boolean, label: string, error?: unknown): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) {
    failures++
    if (error) console.error(`       ${error instanceof Error ? error.message : String(error)}`)
  }
}

const lua = await new LuaFactory().createEngine({ openStandardLibs: true })

// moho.lua only needs the copy-based shape of FA's Class implementation for
// these checks. No original Lua modules or game archives are loaded.
await lua.doString(`
  table.getn = table.getn or function(t) return #t end

  function Class(...)
    local bases = {...}
    return function(definition)
      local class = {}
      for _, base in ipairs(bases) do
        for key, value in pairs(base or {}) do class[key] = value end
      end
      for key, value in pairs(definition or {}) do class[key] = value end
      return class
    end
  end

  function TestInstance(methods, fields)
    return setmetatable(fields or {}, { __index = methods })
  end
`)
await lua.doString(MOHO_LUA)

const luaCheck = async (label: string, source: string): Promise<void> => {
  try {
    check((await lua.doString(source)) === true, label)
  } catch (error) {
    check(false, label, error)
  }
}

console.log('\n== CMauiControl::SetParent ==')
await luaCheck(
  'reparenting removes every stale old-parent entry and never duplicates the new entry',
  `
    local methods = moho.control_methods
    local parentA = TestInstance(methods, { __children = {} })
    local parentB = TestInstance(methods, { __children = {} })
    local sibling = TestInstance(methods, { __children = {} })
    local child = TestInstance(methods, { __parent = parentA, __children = {} })

    -- Include duplicate legacy state to verify that a real reparent repairs it.
    parentA.__children = { child, sibling, child }
    parentB.__children = { child }
    child:SetParent(parentB)
    local detached = #parentA.__children == 1 and parentA.__children[1] == sibling
    local attachedOnce = #parentB.__children == 1 and parentB.__children[1] == child

    __mauiDirty = false
    child:SetParent(parentB)
    local sameParentIsNoop =
      #parentB.__children == 1 and parentB.__children[1] == child
      and __mauiDirty == false

    child:SetParent(nil)
    local detachedToNil = child.__parent == false and #parentB.__children == 0
    return detached and attachedOnce and sameParentIsNoop and detachedToNil
  `,
)

console.log('\n== CMauiControl::SetHidden ==')
await luaCheck(
  'OnHide runs before mutation, child vetoes are local, and a parent veto stops propagation',
  `
    local methods = moho.control_methods
    local calls = {}
    local parent = TestInstance(methods, { __children = {}, __hidden = false })
    local childA = TestInstance(methods, { __children = {}, __hidden = false })
    local childB = TestInstance(methods, { __children = {}, __hidden = false })
    local grandchild = TestInstance(methods, { __children = {}, __hidden = false })
    parent.__children = { childA, childB }
    childB.__children = { grandchild }

    parent.OnHide = function(self, hidden)
      calls[#calls + 1] = 'parent:' .. tostring(hidden) .. ':' .. tostring(self.__hidden)
    end
    childA.OnHide = function(self, hidden)
      calls[#calls + 1] =
        'childA:' .. tostring(hidden) .. ':' .. tostring(self.__hidden)
        .. ':parent=' .. tostring(parent.__hidden)
    end
    childB.OnHide = function(self, hidden)
      calls[#calls + 1] = 'childB:' .. tostring(hidden) .. ':' .. tostring(self.__hidden)
      return hidden
    end
    grandchild.OnHide = function(self, hidden)
      calls[#calls + 1] = 'grandchild:' .. tostring(hidden)
    end

    parent:SetHidden(true)
    local callbackOrder =
      table.concat(calls, ',') ==
      'parent:true:false,childA:true:false:parent=true,childB:true:false'
    local childVetoIsLocal =
      parent.__hidden == true and childA.__hidden == true
      and childB.__hidden == false and grandchild.__hidden == false

    calls = {}
    parent.OnHide = function(self, hidden)
      calls[#calls + 1] = 'parent-veto:' .. tostring(hidden)
      return true
    end
    parent:SetHidden(false)
    local parentVetoed =
      parent.__hidden == true and childA.__hidden == true
      and childB.__hidden == false and grandchild.__hidden == false
    local propagationStopped = #calls == 1 and calls[1] == 'parent-veto:false'

    return callbackOrder and childVetoIsLocal and parentVetoed and propagationStopped
  `,
)

console.log('\n== CMauiItemList::SetNewColors ==')
await luaCheck(
  'all six color slots are nil-partial and retain earlier LazyVar updates',
  `
    local list = TestInstance(moho.item_list_methods, { __colors = { marker = 'kept' } })
    local returned = list:SetNewColors('fg', nil, nil, nil, nil, nil)
    list:SetNewColors(nil, 'bg', nil, nil, nil, nil)
    list:SetNewColors(nil, nil, 'selected-fg', nil, nil, nil)
    list:SetNewColors(nil, nil, nil, 'selected-bg', nil, nil)
    list:SetNewColors(nil, nil, nil, nil, 'mouse-fg', nil)
    list:SetNewColors(nil, nil, nil, nil, nil, 'mouse-bg')
    list:SetNewColors(nil, 'bg-2', nil, nil, nil, nil)
    list:SetNewColors(nil, nil, nil, nil, nil, nil)

    local c = list.__colors
    return returned == list and c.marker == 'kept'
      and c.fg == 'fg' and c.bg == 'bg-2'
      and c.selFg == 'selected-fg' and c.selBg == 'selected-bg'
      and c.mouseFg == 'mouse-fg' and c.mouseBg == 'mouse-bg'
  `,
)

console.log('\n== CMauiScrollbar::SetNewTextures ==')
await luaCheck(
  'all four texture slots are nil-partial and retain earlier LazyVar updates',
  `
    local scrollbar = TestInstance(moho.scrollbar_methods, {
      __textures = { marker = 'kept' },
    })
    local returned = scrollbar:SetNewTextures('background', nil, nil, nil)
    scrollbar:SetNewTextures(nil, 'middle', nil, nil)
    scrollbar:SetNewTextures(nil, nil, 'top', nil)
    scrollbar:SetNewTextures(nil, nil, nil, 'bottom')
    scrollbar:SetNewTextures(nil, 'middle-2', nil, nil)
    scrollbar:SetNewTextures(nil, nil, nil, nil)

    local t = scrollbar.__textures
    return returned == scrollbar and t.marker == 'kept'
      and t.background == 'background' and t.thumbMiddle == 'middle-2'
      and t.thumbTop == 'top' and t.thumbBottom == 'bottom'
  `,
)

lua.global.close()
console.log(
  failures === 0
    ? '\nMAUI CONTROL STATE PASSED'
    : `\n${failures} MAUI CONTROL STATE CHECK(S) FAILED`,
)
process.exitCode = failures === 0 ? 0 : 1
