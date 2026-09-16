import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

/**
 * Routes.
 *
 * `/invite/:id` is the link that gets pasted into a group chat, so it is the one
 * route whose URL shape is a contract: the server renders link-preview tags for
 * exactly this path. Everything else is free to move.
 *
 * Views are lazily loaded so opening an invite from a chat does not download the
 * organizer tooling.
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: () => import('@/views/HomeView.vue'),
  },
  {
    path: '/invite/:id',
    name: 'invite',
    component: () => import('@/views/InviteView.vue'),
  },
  {
    path: '/create',
    name: 'create',
    component: () => import('@/views/CreateView.vue'),
  },
  {
    path: '/manage/:id',
    name: 'manage',
    component: () => import('@/views/ManageView.vue'),
  },
  {
    path: '/bill/:id',
    name: 'bill',
    component: () => import('@/views/BillView.vue'),
  },
  {
    path: '/hosting',
    name: 'hosting',
    component: () => import('@/views/HostingView.vue'),
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
  },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})
