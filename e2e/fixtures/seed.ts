import type { APIRequestContext } from '@playwright/test'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const target = process.env.E2E_TARGET || 'local'
const remoteUrls: Record<string, string> = {
  dev: 'https://dev.hopo.io/graphql',
  staging: 'https://staging.hopo.io/graphql',
  prod: 'https://hopo.io/graphql',
}
const API_URL = process.env.E2E_API_URL || remoteUrls[target] || 'http://localhost:3161/graphql'

function getAuthHeaders(tokenFile = 'admin-token.json'): Record<string, string> {
  if (target === 'local') return {}
  try {
    const tokenPath = resolve(__dirname, `../.auth/${tokenFile}`)
    const tokenData = JSON.parse(readFileSync(tokenPath, 'utf-8'))
    if (tokenData.idToken) {
      return { Authorization: `Bearer ${tokenData.idToken}` }
    }
  } catch {
    // No token available — fall back to unauthenticated
  }
  return {}
}

export { getAuthHeaders }

async function gql(
  request: APIRequestContext,
  query: string,
  variables?: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
  tokenFile?: string
) {
  const res = await request.post(API_URL, {
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(tokenFile),
      ...extraHeaders,
    },
    data: { query, variables },
  })
  const json = await res.json()
  if (json.errors?.length) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`)
  }
  return json.data
}

// ---------------------------------------------------------------------------
// Dwellings
// ---------------------------------------------------------------------------

export async function seedDwelling(
  request: APIRequestContext,
  overrides: { name?: string; type?: string } = {},
  tokenFile?: string
) {
  const data = await gql(
    request,
    `mutation ($input: CreateDwellingInput!) {
      createDwelling(input: $input) { id name type }
    }`,
    {
      input: {
        name: overrides.name ?? 'E2E Test Dwelling',
        type: overrides.type ?? 'HOUSE',
      },
    },
    undefined,
    tokenFile
  )
  return data.createDwelling as { id: string; name: string; type: string }
}

export async function deleteDwelling(request: APIRequestContext, id: string, tokenFile?: string) {
  await gql(
    request,
    `mutation ($id: ID!) { deleteDwelling(id: $id) }`,
    { id },
    { 'x-group-id': id },
    tokenFile
  )
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

export async function seedRoom(
  request: APIRequestContext,
  dwellingId: string,
  overrides: { name?: string; type?: string } = {}
) {
  const data = await gql(
    request,
    `mutation ($input: CreateRoomInput!) {
      createRoom(input: $input) { id name type }
    }`,
    {
      input: {
        name: overrides.name ?? 'E2E Test Room',
        type: overrides.type ?? 'LIVING_ROOM',
      },
    },
    { 'x-group-id': dwellingId }
  )
  return data.createRoom as { id: string; name: string; type: string }
}

export async function deleteRoom(request: APIRequestContext, id: string, dwellingId: string) {
  await gql(
    request,
    `mutation ($id: ID!) { deleteRoom(id: $id) }`,
    { id },
    { 'x-group-id': dwellingId }
  )
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export async function seedItem(
  request: APIRequestContext,
  roomId: string,
  overrides: { description?: string; category?: string } = {},
  groupId?: string
) {
  const headers: Record<string, string> = {}
  if (groupId) headers['x-group-id'] = groupId
  const data = await gql(
    request,
    `mutation ($input: CreateItemInput!) {
      createItem(input: $input) { id description roomId }
    }`,
    {
      input: {
        roomId,
        description: overrides.description ?? 'E2E Test Item',
        category: overrides.category ?? 'OTHER',
      },
    },
    headers
  )
  return data.createItem as { id: string; description: string; roomId: string }
}

export async function deleteItem(
  request: APIRequestContext,
  id: string,
  roomId: string,
  groupId?: string
) {
  const headers: Record<string, string> = {}
  if (groupId) headers['x-group-id'] = groupId
  await gql(
    request,
    `mutation ($id: ID!, $roomId: ID!) { deleteItem(id: $id, roomId: $roomId) }`,
    { id, roomId },
    headers
  )
}

// ---------------------------------------------------------------------------
// Annual Items
// ---------------------------------------------------------------------------

export async function seedAnnualItem(
  request: APIRequestContext,
  overrides: { name?: string; type?: string } = {},
  tokenFile?: string
) {
  const data = await gql(
    request,
    `mutation ($input: CreateAnnualItemInput!) {
      createAnnualItem(input: $input) { id name type }
    }`,
    {
      input: {
        name: overrides.name ?? 'E2E Test Annual Item',
        type: overrides.type ?? 'OTHER',
      },
    },
    undefined,
    tokenFile
  )
  return data.createAnnualItem as { id: string; name: string; type: string }
}

export async function deleteAnnualItem(request: APIRequestContext, id: string, tokenFile?: string) {
  await gql(
    request,
    `mutation ($id: ID!) { deleteAnnualItem(id: $id) }`,
    { id },
    undefined,
    tokenFile
  )
}

// ---------------------------------------------------------------------------
// Queries (read-only)
// ---------------------------------------------------------------------------

export async function fetchDwellings(request: APIRequestContext) {
  const data = await gql(request, `query { dwellings { id name type roomCount } }`)
  return data.dwellings as { id: string; name: string; type: string; roomCount: number }[]
}

export async function fetchRooms(request: APIRequestContext, dwellingId: string) {
  const data = await gql(request, `query { rooms { id name type } }`, undefined, {
    'x-group-id': dwellingId,
  })
  return data.rooms as { id: string; name: string; type: string }[]
}

// ---------------------------------------------------------------------------
// Entitlements (read-only)
// ---------------------------------------------------------------------------

export async function fetchEntitlements(request: APIRequestContext) {
  const data = await gql(
    request,
    `query {
      entitlements {
        tier
        limits { maxDwellings maxItemsPerRoom maxImagesPerItem reminders export sharing }
        subscription { id tier status cancelAtPeriodEnd }
      }
    }`
  )
  return data.entitlements as {
    tier: string
    limits: {
      maxDwellings: number
      maxItemsPerRoom: number
      maxImagesPerItem: number
      reminders: boolean
      export: boolean
      sharing: boolean
    }
    subscription: { id: string; tier: string; status: string; cancelAtPeriodEnd: boolean } | null
  }
}

// ---------------------------------------------------------------------------
// Group Management (modern API — requires X-Group-Id header)
// ---------------------------------------------------------------------------

export async function seedGroupInvite(
  request: APIRequestContext,
  groupId: string,
  email: string,
  role: 'admin' | 'member' | 'viewer' = 'viewer',
  tokenFile?: string
) {
  const data = await gql(
    request,
    `mutation ($email: String!, $role: GroupRole!) {
      createInvite(email: $email, role: $role) { inviteId email role status invitedBy createdAt }
    }`,
    { email, role },
    { 'x-group-id': groupId },
    tokenFile
  )
  return data.createInvite as {
    inviteId: string
    email: string
    role: string
    status: string
    invitedBy: string
    createdAt: string
  }
}

export async function revokeGroupInvite(
  request: APIRequestContext,
  groupId: string,
  inviteId: string,
  tokenFile?: string
) {
  await gql(
    request,
    `mutation ($inviteId: ID!) { revokeInvite(inviteId: $inviteId) }`,
    { inviteId },
    { 'x-group-id': groupId },
    tokenFile
  )
}

export async function acceptGroupInvite(
  request: APIRequestContext,
  inviteId: string,
  tokenFile?: string
) {
  const data = await gql(
    request,
    `mutation ($inviteId: ID!) { acceptInvite(inviteId: $inviteId) { id name } }`,
    { inviteId },
    undefined,
    tokenFile
  )
  return data.acceptInvite as { id: string; name: string }
}

export async function rejectGroupInvite(request: APIRequestContext, inviteId: string) {
  await gql(request, `mutation ($inviteId: ID!) { rejectInvite(inviteId: $inviteId) }`, {
    inviteId,
  })
}

export async function updateGroupMemberRole(
  request: APIRequestContext,
  groupId: string,
  userId: string,
  role: 'admin' | 'member' | 'viewer',
  tokenFile?: string
) {
  const data = await gql(
    request,
    `mutation ($userId: ID!, $role: GroupRole!) {
      updateMemberRole(userId: $userId, role: $role) { userId email role status }
    }`,
    { userId, role },
    { 'x-group-id': groupId },
    tokenFile
  )
  return data.updateMemberRole as { userId: string; email: string; role: string; status: string }
}

export async function removeGroupMember(
  request: APIRequestContext,
  groupId: string,
  userId: string,
  tokenFile?: string
) {
  await gql(
    request,
    `mutation ($userId: ID!) { removeMember(userId: $userId) }`,
    { userId },
    { 'x-group-id': groupId },
    tokenFile
  )
}

export async function fetchGroupMembers(
  request: APIRequestContext,
  groupId: string,
  tokenFile?: string
) {
  const data = await gql(
    request,
    `query { members { userId email displayName role status joinedAt } }`,
    undefined,
    { 'x-group-id': groupId },
    tokenFile
  )
  return data.members as Array<{
    userId: string
    email: string
    displayName: string | null
    role: string
    status: string
    joinedAt: string | null
  }>
}

export async function fetchGroupInvites(
  request: APIRequestContext,
  groupId: string,
  tokenFile?: string
) {
  const data = await gql(
    request,
    `query { pendingInvites { inviteId email role status invitedBy createdAt expiresAt } }`,
    undefined,
    { 'x-group-id': groupId },
    tokenFile
  )
  return data.pendingInvites as Array<{
    inviteId: string
    email: string
    role: string
    status: string
    invitedBy: string
    createdAt: string
    expiresAt: string | null
  }>
}
