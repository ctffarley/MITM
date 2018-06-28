# Man-in-the-middle SSH Server

## Configuration

| Setting | Type | Explanation |
| :--------:| :----: | :------------|
| local | Boolean | Runs the MITM SSH Server without requiring a container. Warning messages will display and there will be limitations (e.g. pty mode is disabled).
| debug   | Boolean | MITM Debug Output. Good option to have enabled when building your honeypot ecosystem. Provides detailed logs of the actions that the MITM takes in real time. |
| attacker.streamOutput | String | Folder where the attacker output streams are placed |
| attacker.maxAttemptsPerConnection | Integer | 
| server.listenIP | String | The IP address to listen on |
| server.identifier | String | The SSH server identifier string sent to the SSH client |
| autoAccess.enabled | Boolean | If true, then enable automatic access to the honeypot after a certain number of login attempts (normal distribution using mean and standard deviation values). Can be manually set in the command line.
| autoAccess.cacheSize | Integer | Number of attacker IPs to hold when autoAccess is turned "on" . This value is required to not overwhelm the host memory. |
| autoAccess.barrier.normalDist.enabled | Boolean | Enable normal distribution to calculate the login attempt threshold per attacker |
| autoAccess.barrier.normalDist.mean | Integer | Mean number of login attempts before automatic access |
| autoAccess.barrier.normalDist.standardDeviation | Integer | Standard Deviation. Automatic access follows a normal distribution.
| autoAccess.barrier.fixed.enabled | Boolean | Enable fixed login attempts threshold |
| autoAccess.barrier.fixed.attempts | Boolean | Number of login attempts |

##

## Start the MITM server

```bash
node /root/mitm/mitm/index.js <class_groupID> <port> <container_ip> <container_id> [autoAccessEnable]
```

## Automatic Access

Allows an attacker to successfully authenticate after a certain number of login attempts.

## Authors
Louis-Henri Merino

Contributions:  
Zhi Xiang Lin  
Franz Payer

## License
MIT License