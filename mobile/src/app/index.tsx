import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { useApp } from "@/lib/app-state";

/** Signed in → my machines; otherwise → sign-in. */
export default function Index() {
  const { ready, account } = useApp();
  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator size="large" />
      </View>
    );
  }
  return <Redirect href={account ? "/machines" : "/sign-in"} />;
}
