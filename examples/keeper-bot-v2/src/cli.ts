
export class Cli {
    public async inspectKeeper(client: any, keeperAddress: string, minEligibilityFloor?: number) {
        const reputation = await client.keeperReputation(keeperAddress);
        console.log(`Keeper reputation: ${reputation}`);

        if (minEligibilityFloor !== undefined && reputation <= minEligibilityFloor + 10) {
            console.warn(`Warning: Reputation (${reputation}) is near or below the eligibility floor (${minEligibilityFloor}).`);
        }
    }
}
