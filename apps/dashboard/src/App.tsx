import { Suspense, lazy } from "react";
import { Navigate, RouterProvider, createBrowserRouter } from "react-router-dom";
import { LoadingState } from "./components/AsyncState";
import { Shell } from "./components/Shell";
import { TasksPage } from "./pages/Tasks";

// Code-split routes so the task explorer loads without heavy write flows and auxiliary pages
const TaskDetailPage = lazy(() => import("./pages/TaskDetail").then((m) => ({ default: m.TaskDetailPage })));
const RegisterTaskPage = lazy(() => import("./pages/RegisterTask").then((m) => ({ default: m.RegisterTaskPage })));
const LeaderboardPage = lazy(() => import("./pages/Leaderboard").then((m) => ({ default: m.LeaderboardPage })));
const KeeperPage = lazy(() => import("./pages/Keeper").then((m) => ({ default: m.KeeperPage })));
const OwnerPage = lazy(() => import("./pages/Owner").then((m) => ({ default: m.OwnerPage })));
const StatsPage = lazy(() => import("./pages/Stats").then((m) => ({ default: m.StatsPage })));
const TreasuryPage = lazy(() => import("./pages/Treasury").then((m) => ({ default: m.TreasuryPage })));
const AdminPage = lazy(() => import("./pages/Admin").then((m) => ({ default: m.AdminPage })));

const router = createBrowserRouter([
  {
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/tasks" replace /> },
      { path: "tasks", element: <TasksPage /> },
      {
        path: "tasks/:taskId",
        element: (
          <Suspense fallback={<LoadingState label="Loading task details..." skeleton="cards" count={4} />}>
            <TaskDetailPage />
          </Suspense>
        ),
      },
      {
        path: "keepers",
        element: (
          <Suspense fallback={<LoadingState label="Loading leaderboard..." skeleton="table" columns={5} />}>
            <LeaderboardPage />
          </Suspense>
        ),
      },
      {
        path: "keepers/:keeper",
        element: (
          <Suspense fallback={<LoadingState label="Loading keeper profile..." skeleton="cards" count={4} />}>
            <KeeperPage />
          </Suspense>
        ),
      },
      {
        path: "owners/:owner",
        element: (
          <Suspense fallback={<LoadingState label="Loading owner view..." skeleton="table" columns={7} />}>
            <OwnerPage />
          </Suspense>
        ),
      },
      {
        path: "stats",
        element: (
          <Suspense fallback={<LoadingState label="Loading stats..." skeleton="cards" count={4} />}>
            <StatsPage />
          </Suspense>
        ),
      },
      {
        path: "treasury",
        element: (
          <Suspense fallback={<LoadingState label="Loading treasury..." skeleton="cards" count={4} />}>
            <TreasuryPage />
          </Suspense>
        ),
      },
      {
        path: "admin",
        element: (
          <Suspense fallback={<LoadingState label="Loading admin panel..." skeleton="cards" count={6} />}>
            <AdminPage />
          </Suspense>
        ),
      },
      {
        path: "register",
        element: (
          <Suspense fallback={<LoadingState label="Loading task registration..." />}>
            <RegisterTaskPage />
          </Suspense>
        ),
      },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
