import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { prisma } from '@crate/db'
import { bootstrapOwner, createOwnerWithBetterAuth } from '../src/lib/bootstrap-owner'

async function hiddenPrompt(label: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('Bootstrap requires an interactive server terminal (TTY).')
  }

  stdout.write(label)
  stdin.setRawMode(true)
  stdin.resume()
  let value = ''
  return new Promise<string>((resolve, reject) => {
    const finish = (result?: string, error?: Error) => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      if (error) reject(error)
      else resolve(result ?? '')
    }
    const onData = (chunk: Buffer | string) => {
      for (const character of String(chunk)) {
        if (character === '\r' || character === '\n') {
          stdout.write('\n')
          finish(value)
          return
        }
        if (character === '\u0003') {
          stdout.write('\n')
          finish(undefined, new Error('Bootstrap cancelled.'))
          return
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1)
        else if (character >= ' ') value += character
      }
    }
    stdin.on('data', onData)
  })
}

async function main(): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Bootstrap requires an interactive server terminal (TTY).')
  if ((await prisma.user.count()) !== 0) throw new Error('An owner account already exists; bootstrap is permanently disabled.')

  const prompts = createInterface({ input: stdin, output: stdout })
  const email = (await prompts.question('Owner email: ')).trim()
  const name = (await prompts.question('Display name: ')).trim()
  prompts.close()

  const password = await hiddenPrompt('Password (not echoed): ')
  const confirmation = await hiddenPrompt('Confirm password (not echoed): ')
  if (password !== confirmation) throw new Error('Passwords do not match.')

  await bootstrapOwner({ email, name, password }, {
    countOwners: () => prisma.user.count(),
    createCredentialUser: createOwnerWithBetterAuth,
  })
  stdout.write('Owner account created. Sign in through the web interface.\n')
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Bootstrap failed.'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
  .finally(async () => prisma.$disconnect())
