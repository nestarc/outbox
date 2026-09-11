import {
  OUTBOX_INVALID_CONFIGURATION,
  OutboxConfigurationError,
} from '../src/errors/outbox-configuration.error';
import type { OutboxOptions } from '../src/interfaces/outbox-options.interface';
import { validateOutboxOptions } from '../src/outbox-invariants';

function options(overrides: Record<string, unknown> = {}): OutboxOptions {
  return {
    prisma: { $queryRaw: jest.fn(), $executeRaw: jest.fn() },
    ...overrides,
  } as OutboxOptions;
}

function expectInvalid(
  overrides: Record<string, unknown>,
  option: string,
): void {
  let caught: unknown;
  try {
    validateOutboxOptions(options(overrides));
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OutboxConfigurationError);
  expect(caught).toMatchObject({ code: OUTBOX_INVALID_CONFIGURATION, option });
}

describe('validateOutboxOptions', () => {
  it('rejects a misspelled tenant policy before an event is emitted', () => {
    expectInvalid({ tenancy: { policy: 'requird' } }, 'tenancy.policy');
  });

  it.each(['optional', 'required', 'require-match'])(
    'accepts the %s tenant policy',
    (policy) => {
      const value = options({ tenancy: { policy } });
      expect(validateOutboxOptions(value)).toBe(value);
    },
  );

  it.each(['tenancy', 'hooks'])(
    'rejects non-object %s configuration',
    (option) => {
      for (const value of [null, [], 'invalid']) {
        expectInvalid({ [option]: value }, option);
      }
    },
  );

  it.each([
    'onEmit',
    'onPollStart',
    'onDispatchStart',
    'onDispatchSuccess',
    'onDispatchFailure',
    'onRetryScheduled',
    'onDeadLetter',
  ])('rejects a non-function hooks.%s callback', (hook) => {
    for (const value of [null, false, 'callback', {}]) {
      expectInvalid({ hooks: { [hook]: value } }, `hooks.${hook}`);
    }
  });

  it('accepts inherited synchronous and asynchronous hook methods without calling them', () => {
    const called = jest.fn();
    class BaseHooks {
      onEmit() {
        called();
      }
      async onPollStart() {
        called();
      }
    }
    class Hooks extends BaseHooks {
      onDispatchStart = called;
      onDispatchSuccess = called;
      onDispatchFailure = called;
      onRetryScheduled = called;
      onDeadLetter = called;
    }
    const value = options({ hooks: new Hooks() });
    expect(validateOutboxOptions(value)).toBe(value);
    expect(called).not.toHaveBeenCalled();
  });

  it.each([
    null,
    42,
    true,
    {},
    [],
    '',
    'invalid\0channel',
    'a'.repeat(64),
    '한'.repeat(22),
  ])('rejects an invalid PostgreSQL notification channel: %p', (channel) => {
    expectInvalid({ wakeup: { channel } }, 'wakeup.channel');
  });

  it.each([
    'channel"name',
    'outbox events',
    ' ',
    'a'.repeat(63),
    '한'.repeat(21),
  ])(
    'accepts a quoted PostgreSQL channel within the byte limit: %p',
    (channel) => {
      const value = options({ wakeup: { channel } });
      expect(validateOutboxOptions(value)).toBe(value);
    },
  );

  it('rejects non-string wakeup connection strings', () => {
    for (const connectionString of [null, 42, false, {}, []]) {
      expectInvalid(
        { wakeup: { connectionString } },
        'wakeup.connectionString',
      );
    }
  });

  it('accepts an empty connection string so pg can use its default configuration', () => {
    const value = options({ wakeup: { connectionString: '' } });
    expect(validateOutboxOptions(value)).toBe(value);
  });

  it('rejects non-function wakeup client factories', () => {
    for (const clientFactory of [null, 42, false, {}, []]) {
      expectInvalid({ wakeup: { clientFactory } }, 'wakeup.clientFactory');
    }
  });

  it('accepts synchronous and asynchronous client factories without calling them', () => {
    const factories = [jest.fn(() => null), jest.fn(async () => null)];
    for (const clientFactory of factories) {
      const value = options({ wakeup: { clientFactory } });
      expect(validateOutboxOptions(value)).toBe(value);
      expect(clientFactory).not.toHaveBeenCalled();
    }
  });

  it('rejects tenant providers that are neither objects nor class references', () => {
    for (const provider of [null, [], 'provider', 42, true, () => null]) {
      expectInvalid({ tenancy: { provider } }, 'tenancy.provider');
    }
  });

  it.each(['getTenantId', 'runWithTenant'])(
    'rejects a non-function tenancy.provider.%s method',
    (method) => {
      for (const value of [null, false, 'callback', {}]) {
        expectInvalid(
          { tenancy: { provider: { [method]: value } } },
          `tenancy.provider.${method}`,
        );
      }
    },
  );

  it('accepts an empty tenant provider because both methods are optional', () => {
    const value = options({ tenancy: { provider: {} } });
    expect(validateOutboxOptions(value)).toBe(value);
  });

  it('accepts an instance with inherited tenant provider methods', () => {
    class BaseProvider {
      getTenantId() {
        return 'tenant-1';
      }
      runWithTenant<T>(_tenantId: string, callback: () => Promise<T>) {
        return callback();
      }
    }
    class Provider extends BaseProvider {}
    const value = options({ tenancy: { provider: new Provider() } });
    expect(validateOutboxOptions(value)).toBe(value);
  });

  it('accepts provider classes with prototype methods or instance fields without constructing them', () => {
    const constructed = jest.fn();
    class MethodProvider {
      constructor() {
        constructed();
        throw new Error('Provider constructors belong to Nest DI');
      }
      getTenantId() {
        return 'tenant-1';
      }
    }
    class FieldProvider extends MethodProvider {
      getTenantId = () => 'tenant-2';
    }
    class InheritedProvider extends MethodProvider {}

    for (const provider of [
      MethodProvider,
      FieldProvider,
      InheritedProvider,
      MethodProvider.bind(null),
    ]) {
      const value = options({ tenancy: { provider } });
      expect(validateOutboxOptions(value)).toBe(value);
    }
    expect(constructed).not.toHaveBeenCalled();
  });
});
