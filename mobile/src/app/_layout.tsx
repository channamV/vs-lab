import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AppProvider } from "@/lib/app-state";
import { colors } from "@/components/ui";

export default function RootLayout() {
  return (
    <AppProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.brand },
          headerTintColor: "#fff",
          headerTitleStyle: { fontWeight: "600" },
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="sign-in" options={{ title: "VS Lab" }} />
        <Stack.Screen name="machines" options={{ title: "My machines" }} />
        <Stack.Screen name="machine/[code]/checklist" options={{ title: "Check in" }} />
        <Stack.Screen name="machine/[code]/problem" options={{ title: "Report a problem" }} />
      </Stack>
    </AppProvider>
  );
}
