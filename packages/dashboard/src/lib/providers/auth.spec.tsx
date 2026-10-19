import { LS_KEY_SELECTED_CHANNEL_TOKEN } from '@/vdb/constants.js';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { DocumentNode, getOperationAST } from 'graphql';
import { act, useContext } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiQueryMock = vi.hoisted(() => vi.fn());
const apiMutateMock = vi.hoisted(() => vi.fn());
const useUserSettingsMock = vi.hoisted(() => vi.fn());

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/vdb/graphql/api.js', () => ({ api: { query: apiQueryMock, mutate: apiMutateMock } }));
vi.mock('@/vdb/hooks/use-user-settings.js', () => ({ useUserSettings: useUserSettingsMock }));

import { AuthContext, AuthProvider } from './auth.js';

// The avatar query is a plain string; the tests only route graphql() documents.
function operationName(document: string | DocumentNode): string | undefined {
    return typeof document === 'string' ? undefined : getOperationAST(document)?.name?.value;
}

const loggedOut = { me: null, activeAdministrator: null };

function currentUser(id: string, channels: Array<{ id: string; token: string }>) {
    return {
        me: {
            id,
            identifier: id,
            channels: channels.map(c => ({ ...c, code: c.token, permissions: ['ReadCatalog'] })),
        },
        activeAdministrator: {
            id,
            firstName: 'First',
            lastName: 'Last',
            emailAddress: `${id}@test.com`,
            user: { id, identifier: id, roles: [] },
        },
    };
}

describe('AuthProvider login', () => {
    let container: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;
    let auth: AuthContext | null;
    let channelQueryData: string | null | undefined;
    let currentUserResponse: unknown;
    let pendingChannelResponses: Array<() => void>;

    // Stands in for ChannelProvider's channel queries: reads the channel token at
    // request time and responds only when login() releases it.
    function Probe() {
        auth = useContext(AuthContext);
        const { data } = useQuery({
            queryKey: ['activeChannel'],
            queryFn: () => {
                const token = localStorage.getItem(LS_KEY_SELECTED_CHANNEL_TOKEN);
                return new Promise<string | null>(resolve =>
                    pendingChannelResponses.push(() => resolve(token)),
                );
            },
        });
        channelQueryData = data;
        return null;
    }

    async function render() {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        await act(async () => {
            root.render(
                <QueryClientProvider client={client}>
                    <AuthProvider>
                        <Probe />
                    </AuthProvider>
                </QueryClientProvider>,
            );
        });
    }

    // login() writes the new token and then, in the same synchronous run, cancels or
    // invalidates queries. Holding every channel response until the new token is
    // visible therefore makes the stale request still be in flight at that point.
    async function login(newToken: string) {
        await act(async () => {
            auth?.login('user', 'password');
        });
        await act(async () => {
            await vi.waitFor(() => {
                if (localStorage.getItem(LS_KEY_SELECTED_CHANNEL_TOKEN) === newToken) {
                    pendingChannelResponses.splice(0).forEach(respond => respond());
                }
                if (auth?.status !== 'authenticated' || pendingChannelResponses.length) {
                    throw new Error('login has not completed');
                }
            });
        });
    }

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        auth = null;
        channelQueryData = undefined;
        currentUserResponse = loggedOut;
        pendingChannelResponses = [];
        localStorage.clear();
        useUserSettingsMock.mockReturnValue({
            settings: { activeChannelId: '' },
            setActiveChannelId: vi.fn(),
        });
        apiQueryMock.mockImplementation(async (document: string | DocumentNode) =>
            operationName(document) === 'CurrentUserInformation' ? currentUserResponse : {},
        );
        apiMutateMock.mockReturnValue(async () => ({
            login: { __typename: 'CurrentUser', id: 'user', identifier: 'user' },
        }));
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        container.remove();
        localStorage.clear();
        vi.clearAllMocks();
    });

    // Switching users without a reload: a channel query started under the previous
    // user's token must not survive login, or the new user is left without an
    // active channel and the nav menu hides every permission-gated entry.
    it('refetches a channel query that was in flight with the previous token', async () => {
        localStorage.setItem(LS_KEY_SELECTED_CHANNEL_TOKEN, 'previous-user-token');
        await render();

        currentUserResponse = currentUser('business', [{ id: '2', token: 'business-token' }]);
        await login('business-token');

        expect(localStorage.getItem(LS_KEY_SELECTED_CHANNEL_TOKEN)).toBe('business-token');
        expect(channelQueryData).toBe('business-token');
    });

    it('keeps the remembered channel when the user can still access it', async () => {
        useUserSettingsMock.mockReturnValue({
            settings: { activeChannelId: '2' },
            setActiveChannelId: vi.fn(),
        });
        await render();

        currentUserResponse = currentUser('admin', [
            { id: '1', token: 'default-token' },
            { id: '2', token: 'second-token' },
        ]);
        await login('second-token');

        expect(localStorage.getItem(LS_KEY_SELECTED_CHANNEL_TOKEN)).toBe('second-token');
        expect(channelQueryData).toBe('second-token');
    });
});
