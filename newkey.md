# New Soniox key

Use this if the Soniox key was shared with someone who shouldn't have it, or Soniox has stopped accepting it. The sound desk link and QR code do not change.

## Start

Click the **copy** button on the box below (it pastes into the terminal at the bottom of the screen), then press **Enter**. Use the venue Google account.

```bash
./deploy.sh --new-key
```

When it asks, create a key at [API keys](https://console.soniox.com/org/projects/api/keys), paste it, and press **Enter**. Nothing appears while you paste. That's normal.

When the terminal says **Done!**, the new key is on the server. Delete the old key on that same page. Soniox keeps accepting the old key until you delete it.
